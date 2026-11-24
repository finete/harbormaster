// The herdr import reader (docs/import.md I2, F7) against state recorded from
// the real herdr 0.9.5 by scripts/record-herdr-fixtures.mjs
// (tests/fixtures/import/herdr/0.9.5/): the `session.json` of a default and a
// named session, `herdr session list --json` and `herdr api snapshot`.
//
// The only fake is a `herdr` shell stand-in that prints those recorded
// outputs (our wiring: which arguments the reader spawns); what herdr writes
// and answers is never hand-written. The legacy-shape test uses herdr's own
// test data (fixtures/import/herdr/source-tests/). A few tests alter a copy
// of the recorded `session.json` (agent kinds herdr's recording did not
// produce, an unknown version): they say so.

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportHerdrAccess } from "../src/access/import-herdr-access.js";
import type {
  ImportOrchestratorRecord,
  ImportReadOptions,
} from "../src/contracts/import.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "import",
  "herdr",
);
const RECORDED = join(FIXTURES, "0.9.5");
const READ: ImportReadOptions = { since: new Date(0) };

let temp: string;
let cfg: string;
let log: string;

/** Copies the recorded tree under `temp`, expanding `__ROOT__` / `__HOME__`. */
function expand(text: string): string {
  return text
    .split("__ROOT__")
    .join(temp)
    .split("__HOME__")
    .join(`${temp}/home`);
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    if (statSync(source).isDirectory()) copyTree(source, join(to, name));
    else writeFileSync(join(to, name), expand(readFileSync(source, "utf8")));
  }
}

interface FakeOptions {
  /** Recorded `session list` file. */
  list?: "session-list.json" | "session-list-scratch-stopped.json";
  /** Sessions whose `api snapshot` answers (the others fail like a stopped server). */
  live?: ("default" | "scratch")[];
}

/** A `herdr` stand-in printing the recorded outputs; every call is appended to `log`. */
function fakeHerdr(options: FakeOptions = {}): string {
  const list = options.list ?? "session-list.json";
  const live = options.live ?? ["default", "scratch"];
  const answer = (name: string, file: string): string =>
    live.includes(name as "default")
      ? `cat '${temp}/${file}'`
      : `echo 'herdr is not running' >&2; exit 1`;
  const script = `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  "session list --json") cat '${temp}/${list}' ;;
  "api snapshot") ${answer("default", "api-snapshot-default.json")} ;;
  "--session scratch api snapshot") ${answer("scratch", "api-snapshot-scratch.json")} ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;
  const path = join(temp, "bin", "herdr");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function reader(herdrBinary: string): ImportHerdrAccess {
  return new ImportHerdrAccess({ configDir: join(cfg, "herdr"), herdrBinary });
}

function calls(): string[] {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function find(
  records: ImportOrchestratorRecord[],
  session: string,
  folder: string,
): ImportOrchestratorRecord {
  const record = records.find(
    (r) => r.orchestratorSession === session && r.cwd === `${temp}/${folder}`,
  );
  if (!record) throw new Error(`no record for ${session}:${folder}`);
  return record;
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "hm-import-herdr-"));
  copyTree(RECORDED, temp);
  cfg = join(temp, "cfg");
  log = join(temp, "calls.log");
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("ImportHerdrAccess: recorded herdr 0.9.5 state", () => {
  it("reads every session's session.json (default and named) with names, folders and session refs, with no binary", async () => {
    const reading = await reader(join(temp, "no-such-herdr")).read(READ);

    expect(reading.error).toBeUndefined();
    expect(reading.sessions).toEqual([]);
    const records = reading.orchestrations;
    expect(
      records
        .map((r) => `${r.orchestratorSession}:${r.cwd.slice(temp.length + 1)}`)
        .sort(),
    ).toEqual([
      "default:billing-service",
      "default:plain-folder",
      "default:worktrees/billing-rework",
      "scratch:worktrees/scratch-notes",
    ]);

    const billing = find(records, "default", "worktrees/billing-rework");
    expect(billing).toMatchObject({
      source: "herdr",
      workspaceId: "w1",
      workspaceName: "Billing rework",
      running: false,
    });
    expect(billing.sessions).toHaveLength(1);
    expect(billing.sessions[0]).toMatchObject({
      agent: "pi",
      harness: "pi",
    });
    expect(billing.sessions[0]?.sessionPath).toMatch(
      /^.+\/home\/\.pi\/agent\/sessions\/--.+-worktrees-billing-rework--\/.+_[0-9a-f-]+\.jsonl$/,
    );
    expect(billing.sessions[0]?.sessionId).toBeUndefined();

    // A second tab of the same workspace on another folder: same name, no session.
    expect(find(records, "default", "billing-service")).toMatchObject({
      workspaceId: "w1",
      workspaceName: "Billing rework",
      sessions: [],
    });
    // A workspace without a custom name has no workspaceName (herdr's live
    // label "plain-folder" is not a custom_name).
    const plain = find(records, "default", "plain-folder");
    expect(plain.workspaceName).toBeUndefined();
    expect(plain.workspaceId).toBe("w2");

    expect(find(records, "scratch", "worktrees/scratch-notes")).toMatchObject({
      workspaceName: "Scratch notes",
      sessions: [{ agent: "pi", harness: "pi" }],
    });
  });

  it("marks a folder running from the live snapshot, matched by pane (not by workspace)", async () => {
    const reading = await reader(fakeHerdr()).read(READ);
    const records = reading.orchestrations;

    expect(reading.error).toBeUndefined();
    // Pi sits (idle) in the worktree pane: its process holds the session.
    expect(find(records, "default", "worktrees/billing-rework").running).toBe(
      true,
    );
    // The same workspace's other tab and the plain workspace run no agent.
    expect(find(records, "default", "billing-service").running).toBe(false);
    expect(find(records, "default", "plain-folder").running).toBe(false);
    expect(find(records, "scratch", "worktrees/scratch-notes").running).toBe(
      true,
    );
    expect(calls().sort()).toEqual([
      "--session scratch api snapshot",
      "api snapshot",
      "session list --json",
    ]);
  });

  it("asks only a running session for live data: a stopped named session is file-only", async () => {
    const binary = fakeHerdr({ list: "session-list-scratch-stopped.json" });
    const records = (await reader(binary).read(READ)).orchestrations;

    expect(find(records, "default", "worktrees/billing-rework").running).toBe(
      true,
    );
    const scratch = find(records, "scratch", "worktrees/scratch-notes");
    expect(scratch.running).toBe(false);
    expect(scratch.sessions).toHaveLength(1);
    expect(calls()).not.toContain("--session scratch api snapshot");
  });

  it("treats a server that is not running as nothing live: files still read, no error, no throw", async () => {
    const binary = fakeHerdr({ live: [] });
    const reading = await reader(binary).read(READ);

    expect(reading.error).toBeUndefined();
    expect(reading.orchestrations).toHaveLength(4);
    expect(reading.orchestrations.every((r) => !r.running)).toBe(true);
    expect(
      find(reading.orchestrations, "default", "worktrees/billing-rework")
        .sessions,
    ).toHaveLength(1);
  });

  it("treats a hanging herdr as nothing live (short timeout), never a throw", async () => {
    const hang = join(temp, "bin", "hang");
    mkdirSync(dirname(hang), { recursive: true });
    writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(hang, 0o755);
    const started = Date.now();
    const reading = await new ImportHerdrAccess({
      configDir: join(cfg, "herdr"),
      herdrBinary: hang,
      timeoutMs: 300,
    }).read(READ);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reading.orchestrations).toHaveLength(4);
    expect(reading.orchestrations.every((r) => !r.running)).toBe(true);
  });

  it("returns empty (no error) when there is no herdr state at all", async () => {
    const reading = await new ImportHerdrAccess({
      configDir: join(temp, "nothing", "herdr"),
      herdrBinary: join(temp, "no-such-herdr"),
    }).read(READ);

    expect(reading).toEqual({ sessions: [], orchestrations: [] });
  });

  it("finds the config dir from XDG_CONFIG_HOME, else <home>/.config/herdr; an explicit home wins over XDG", async () => {
    const binary = join(temp, "no-such-herdr");
    const viaXdg = await new ImportHerdrAccess({
      env: { XDG_CONFIG_HOME: cfg },
      herdrBinary: binary,
    }).read(READ);
    expect(viaXdg.orchestrations).toHaveLength(4);

    const home = join(temp, "someone");
    copyTree(cfg, join(home, ".config"));
    const viaHome = await new ImportHerdrAccess({
      env: {},
      home,
      herdrBinary: binary,
    }).read(READ);
    expect(viaHome.orchestrations).toHaveLength(4);

    // e2e's fake home must never reach the user's real herdr state.
    const fakeHome = await new ImportHerdrAccess({
      env: { XDG_CONFIG_HOME: cfg },
      home: join(temp, "empty-home"),
      herdrBinary: binary,
    }).read(READ);
    expect(fakeHome.orchestrations).toHaveLength(0);
  });
});

describe("ImportHerdrAccess: snapshot versions", () => {
  it("reads herdr's own version-2 legacy (pre-tabs) snapshot: root pane cwd, no id", async () => {
    const dir = join(temp, "legacy", "herdr");
    mkdirSync(dir, { recursive: true });
    cpSync(
      join(FIXTURES, "source-tests", "legacy-pre-tabs-v2.json"),
      join(dir, "session.json"),
    );
    const reading = await new ImportHerdrAccess({
      configDir: dir,
      herdrBinary: join(temp, "no-such-herdr"),
    }).read(READ);

    expect(reading.error).toBeUndefined();
    expect(reading.orchestrations).toEqual([
      {
        source: "herdr",
        orchestratorSession: "default",
        workspaceName: "legacy",
        cwd: "/tmp/pion",
        sessions: [],
        running: false,
      },
      {
        source: "herdr",
        orchestratorSession: "default",
        workspaceName: "legacy",
        cwd: "/tmp/herdr",
        sessions: [],
        running: false,
      },
    ]);
  });

  it("refuses a snapshot version newer than herdr's (error on the reading), keeping the other sessions", async () => {
    const file = join(cfg, "herdr", "sessions", "scratch", "session.json");
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    // A copy of the recorded file with a future version (not recorded).
    writeFileSync(file, JSON.stringify({ ...snapshot, version: 99 }));
    const reading = await reader(join(temp, "no-such-herdr")).read(READ);

    expect(reading.error).toBe(
      'herdr session "scratch": snapshot version 99 is newer than supported 3',
    );
    expect(
      reading.orchestrations.map((r) => r.orchestratorSession),
    ).not.toContain("scratch");
    expect(reading.orchestrations).toHaveLength(3);
  });

  it("reports an unreadable session.json instead of throwing", async () => {
    writeFileSync(join(cfg, "herdr", "session.json"), "{ not json");
    const reading = await reader(join(temp, "no-such-herdr")).read(READ);

    expect(reading.error).toMatch(/^herdr session "default": not valid JSON/);
    expect(reading.orchestrations.map((r) => r.orchestratorSession)).toEqual([
      "scratch",
    ]);
  });
});

describe("ImportHerdrAccess: agent mapping", () => {
  /** Rewrites the recorded default session's first pane (a modified copy: herdr's recording only produced Pi path sessions). */
  function withPane(pane: Record<string, unknown>): void {
    const file = join(cfg, "herdr", "session.json");
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    snapshot.workspaces[0].tabs[0].panes["1"] = {
      cwd: `${temp}/worktrees/billing-rework`,
      ...pane,
    };
    writeFileSync(file, JSON.stringify(snapshot));
  }

  async function refs() {
    const reading = await reader(join(temp, "no-such-herdr")).read(READ);
    return find(reading.orchestrations, "default", "worktrees/billing-rework")
      .sessions;
  }

  it("maps herdr's agent names to harness ids and keeps id/path kinds apart", async () => {
    for (const [agent, harness] of [
      ["claude", "claude-code"],
      ["codex", "codex"],
      ["cursor", "cursor"],
    ] as const) {
      withPane({
        agent_session: {
          source: `herdr:${agent}`,
          agent,
          kind: "id",
          value: "abc-123",
        },
      });
      expect(await refs()).toEqual([{ agent, harness, sessionId: "abc-123" }]);
    }
    withPane({
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: "path",
        value: "/x/s.jsonl",
      },
    });
    expect(await refs()).toEqual([
      { agent: "pi", harness: "pi", sessionPath: "/x/s.jsonl" },
    ]);
  });

  it("keeps an agent without an adapter, with no harness", async () => {
    withPane({
      agent_session: {
        source: "herdr:omp",
        agent: "omp",
        kind: "id",
        value: "o-1",
      },
    });
    const [ref] = await refs();
    expect(ref).toEqual({ agent: "omp", sessionId: "o-1" });
    expect(ref).not.toHaveProperty("harness");
  });

  it("falls back to agent_resume argv when there is no agent_session", async () => {
    withPane({
      agent_resume: {
        source: "herdr:claude",
        agent: "claude",
        argv: ["claude", "--resume", "c-9"],
      },
    });
    expect(await refs()).toEqual([
      { agent: "claude", harness: "claude-code", sessionId: "c-9" },
    ]);
    withPane({
      agent_resume: {
        source: "herdr:codex",
        agent: "codex",
        argv: ["codex", "resume", "x-1"],
      },
    });
    expect(await refs()).toEqual([
      { agent: "codex", harness: "codex", sessionId: "x-1" },
    ]);
    withPane({
      agent_resume: {
        source: "herdr:pi",
        agent: "pi",
        argv: ["pi", "--session", "/p/s.jsonl"],
      },
    });
    expect(await refs()).toEqual([
      { agent: "pi", harness: "pi", sessionPath: "/p/s.jsonl" },
    ]);
  });
});
