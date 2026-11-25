// Process detection (docs/import.md F3, F6, I13) on the recorded `ps` /
// `lsof` output and Claude registry (scripts/record-import-fixtures.mjs
// --harness processes).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AgentProcessAccess,
  buildRunningAgents,
  classifyAgentProcess,
  parseClaudeRegistryEntry,
  parseLsofCwds,
  parsePs,
} from "../src/access/agent-process-access.js";
import { IMPORT_FIXTURES } from "./helpers/import-fixtures.js";

const DIR = join(IMPORT_FIXTURES, "processes");
const ROOT = "/tmp/hm-recorded-root";
const fill = (text: string) =>
  text.split("__ROOT__").join(ROOT).split("__HOME__").join("/Users/someone");
const ps = fill(readFileSync(join(DIR, "ps.txt"), "utf8"));
// `ps lstart` is local time, and production parses it in the same zone `ps`
// ran in. Replay it in the recording's zone, not the runner's (CI is UTC).
const recording = JSON.parse(
  readFileSync(join(DIR, "recording.json"), "utf8"),
) as { timeZone: string };
const runnerTimeZone = process.env.TZ;
process.env.TZ = recording.timeZone;
afterAll(() => {
  if (runnerTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = runnerTimeZone;
});
const lsof = fill(readFileSync(join(DIR, "lsof.txt"), "utf8"));
const registry = readdirSync(join(DIR, "claude-sessions")).map((name) =>
  parseClaudeRegistryEntry(
    fill(readFileSync(join(DIR, "claude-sessions", name), "utf8")),
  ),
);

describe("ps / lsof parsing (recorded)", () => {
  const rows = parsePs(ps);
  const cwds = parseLsofCwds(lsof);

  it("parses every recorded ps line with its start time", () => {
    expect(rows.length).toBe(ps.split("\n").filter(Boolean).length);
    expect(rows.every((row) => row.pid > 0 && row.startedAtMs > 0)).toBe(true);
  });

  it("classifies the four recorded agents and none of the daemons", () => {
    const own = rows.filter((row) => cwds.get(row.pid) === `${ROOT}/wt`);
    const kinds = own.map((row) => classifyAgentProcess(row.tokens));
    // a Pi (plus its helper processes), Claude, Codex, Cursor's agent; Cursor's worker-server is not one
    expect(new Set(kinds.filter(Boolean))).toEqual(
      new Set(["pi", "claude-code", "codex", "cursor"]),
    );
    expect(kinds).toContain(undefined); // cursor worker-server
    const daemons = rows.filter((row) => row.tokens.includes("app-server"));
    expect(daemons.length).toBeGreaterThan(0);
    for (const row of daemons)
      expect(classifyAgentProcess(row.tokens)).toBeUndefined();
    const workers = rows.filter((row) => row.tokens.includes("worker-server"));
    expect(workers.length).toBeGreaterThan(0);
    for (const row of workers)
      expect(classifyAgentProcess(row.tokens)).toBeUndefined();
  });

  it("reads each process's cwd from the one batched lsof output", () => {
    expect(cwds.size).toBeGreaterThan(5);
    expect([...cwds.values()]).toContain(`${ROOT}/wt`);
  });

  it("a live Claude process with a fresh registry file is session-exact; others are folder-level", () => {
    const entry = registry[0];
    expect(entry?.cwd).toBe(`${ROOT}/wt`);
    const agents = buildRunningAgents(
      rows,
      cwds,
      registry.filter((e) => !!e),
    );
    const claude = agents.filter(
      (agent) => agent.cwd === `${ROOT}/wt` && agent.harness === "claude-code",
    );
    expect(claude).toEqual([
      {
        harness: "claude-code",
        pid: entry?.pid,
        cwd: `${ROOT}/wt`,
        sessionId: entry?.sessionId,
      },
    ]);
    const others = agents.filter((agent) => agent.harness !== "claude-code");
    expect(others.length).toBeGreaterThan(3);
    expect(others.every((agent) => agent.sessionId === undefined)).toBe(true);
  });

  it("a registry file whose pid is dead, or recycled (start time mismatch), is stale", () => {
    const entry = registry[0];
    if (!entry) throw new Error("no recorded registry file");
    const stale = [
      { ...entry, pid: 1 }, // no such Claude process
      { ...entry, startedAt: entry.startedAt + 3 * 60 * 60_000 }, // same pid, a different start
    ];
    for (const candidate of stale) {
      const agents = buildRunningAgents(rows, cwds, [candidate]);
      expect(agents.filter((agent) => agent.sessionId)).toEqual([]);
    }
    // the Claude process is still reported, folder-level
    const agents = buildRunningAgents(rows, cwds, [{ ...entry, startedAt: 0 }]);
    expect(agents.find((agent) => agent.pid === entry.pid)).toMatchObject({
      harness: "claude-code",
      cwd: `${ROOT}/wt`,
    });
  });

  it("classification edge cases", () => {
    expect(classifyAgentProcess(["pi", "pi"])).toBe("pi");
    expect(classifyAgentProcess(["claude", "claude", "--resume", "x"])).toBe(
      "claude-code",
    );
    expect(
      classifyAgentProcess(["/usr/bin/vim", "vim", "claude.md"]),
    ).toBeUndefined();
    expect(
      classifyAgentProcess(["codex", "/x/vendor/bin/codex", "exec", "hi"]),
    ).toBeUndefined();
    expect(
      classifyAgentProcess(["codex", "/x/vendor/bin/codex", "-c", "a=b"]),
    ).toBe("codex");
  });
});

describe("AgentProcessAccess", () => {
  it("runs ps, then ONE lsof for the agent pids, with injected output", async () => {
    const calls: string[][] = [];
    const access = new AgentProcessAccess({
      home: "/nonexistent-home",
      output: async (command, args) => {
        calls.push([command, ...args]);
        return command === "ps" ? ps : lsof;
      },
    });
    const agents = await access.listRunningAgents();
    expect(calls.filter(([command]) => command === "lsof")).toHaveLength(1);
    expect(calls[1]?.[5]).toMatch(/^\d+(,\d+)+$/);
    expect(agents.length).toBeGreaterThan(5);
  });

  it("no agents: no lsof at all", async () => {
    const calls: string[] = [];
    const access = new AgentProcessAccess({
      home: "/nonexistent-home",
      output: async (command) => {
        calls.push(command);
        return "";
      },
    });
    expect(await access.listRunningAgents()).toEqual([]);
    expect(calls).toEqual(["ps"]);
  });
});
