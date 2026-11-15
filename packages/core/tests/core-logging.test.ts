// The core operation log (contracts/logger.ts): line format, timed spans,
// the session-file confirmation after a `new` launch, and rules-file
// problems reported once.

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/contracts/index.js";
import {
  consoleCoreLogger,
  createCore,
  dueSessionFileChecks,
  formatCoreLogLine,
  PiHarnessAdapter,
  piSessionDir,
  SESSION_FILE_GRACE_MS,
  sessionFileCheckWarning,
  shouldWatchSessionFile,
  timed,
} from "../src/index.js";
import { captureLogger } from "./fixtures/capture-logger.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-core-log-")),
  );
  roots.push(root);
  return root;
}

class MovableClock implements Clock {
  ms = Date.parse("2026-01-01T00:00:00.000Z");
  now(): Date {
    return new Date(this.ms);
  }
}

describe("log line format", () => {
  it("prints [core:<scope>] message {json} and drops undefined fields", () => {
    expect(
      formatCoreLogLine("git", "worktree.create ok", {
        branch: "fix-x",
        ms: 812,
        outcome: "ok",
        error: undefined,
      }),
    ).toBe(
      '[core:git] worktree.create ok {"branch":"fix-x","ms":812,"outcome":"ok"}',
    );
    expect(formatCoreLogLine("refresh", "refresh ok")).toBe(
      "[core:refresh] refresh ok",
    );
    const printed: string[] = [];
    const sink = {
      info: (line: string) => printed.push(`I ${line}`),
      warn: (line: string) => printed.push(`W ${line}`),
      error: () => {
        throw new Error("broken sink");
      },
    };
    const logger = consoleCoreLogger(sink);
    logger.warn("session", "no file", { taskId: "t1" });
    expect(() => logger.error("state", "boom")).not.toThrow();
    expect(printed).toEqual(['W [core:session] no file {"taskId":"t1"}']);
  });

  it("timed rethrows the very same error after logging failed with ms and the message", async () => {
    const logger = captureLogger();
    const original = new Error("first line\nfatal: the reason");
    const caught = await timed(
      logger,
      "git",
      "branch.delete",
      { branch: "b" },
      () => Promise.reject(original),
    ).catch((error: unknown) => error);
    expect(caught).toBe(original);
    expect(logger.lines).toEqual([
      {
        level: "warn",
        scope: "git",
        message: "branch.delete failed",
        fields: {
          op: "branch.delete",
          branch: "b",
          ms: expect.any(Number),
          outcome: "failed",
          error: "first line / fatal: the reason",
        },
      },
    ]);
  });
});

describe("session-file check decision", () => {
  const entry = {
    taskId: "t1",
    sessionId: "s1",
    dir: "/sessions/--x--",
    fileSuffix: "_s1.jsonl",
    armedAtMs: 1_000,
  };

  it("watches only a prompted `new` launch", () => {
    expect(shouldWatchSessionFile({ mode: "new", sessionId: "s" }, true)).toBe(
      true,
    );
    expect(shouldWatchSessionFile({ mode: "new", sessionId: "s" }, false)).toBe(
      false,
    );
    expect(
      shouldWatchSessionFile({ mode: "resume", sessionId: "s" }, true),
    ).toBe(false);
    expect(shouldWatchSessionFile(undefined, true)).toBe(false);
  });

  it("is due only after the grace window; present -> nothing, absent -> warning", () => {
    expect(
      dueSessionFileChecks([entry], 1_000 + SESSION_FILE_GRACE_MS - 1),
    ).toEqual([]);
    expect(
      dueSessionFileChecks([entry], 1_000 + SESSION_FILE_GRACE_MS),
    ).toEqual([entry]);
    expect(sessionFileCheckWarning(entry, true)).toBeUndefined();
    expect(sessionFileCheckWarning(entry, false)).toBe(
      "no session file appeared for task t1 (expected under /sessions/--x--)",
    );
  });

  it("maps a cwd onto Pi's sessions directory", () => {
    expect(piSessionDir("/Users/me/wt/fix-x", "/home/.pi/agent")).toBe(
      "/home/.pi/agent/sessions/--Users-me-wt-fix-x--",
    );
  });
});

describe("session launch + file confirmation (createCore, Pi adapter)", () => {
  async function fixture() {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const agentDir = join(root, "pi-agent");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({ automation: false, codeRoot: join(root, "Code") }),
    );
    const clock = new MovableClock();
    const logger = captureLogger();
    const harness = new PiHarnessAdapter({ stateDir, agentDir, clock });
    const core = createCore({ stateDir, clock, harness, logger });
    const task = await core.commands.launchTask({
      relation: "standalone",
      title: "Scratch",
      prompt: "do the thing",
      repository: { none: true },
    });
    const cwd = (await core.commands.getTaskWorkspace(task.id))
      ?.worktreePath as string;
    return { core, clock, logger, task, cwd, agentDir };
  }

  it("logs the decision with the expected dir, then warns once when no file appeared after ~20 s", async () => {
    const f = await fixture();
    const launch = await f.core.commands.claimSessionLaunch(f.task.id);
    if (launch?.mode !== "new") throw new Error("expected a new launch");
    const sessionDir = piSessionDir(f.cwd, f.agentDir);
    expect(f.logger.find("launch new")[0]).toMatchObject({
      scope: "session",
      fields: {
        taskId: f.task.id,
        mode: "new",
        sessionId: launch.sessionId,
        sessionDir,
      },
    });

    // Inside the window: nothing is checked yet.
    f.clock.ms += SESSION_FILE_GRACE_MS - 1_000;
    expect(await f.core.commands.checkPendingSessionFiles()).toBe(0);
    expect(f.logger.find("no session file")).toEqual([]);

    f.clock.ms += 2_000;
    expect(await f.core.commands.checkPendingSessionFiles()).toBe(1);
    expect(f.logger.find("no session file")).toEqual([
      {
        level: "warn",
        scope: "session",
        message: `no session file appeared for task ${f.task.id} (expected under ${sessionDir})`,
        fields: {
          taskId: f.task.id,
          sessionId: launch.sessionId,
          outcome: "missing",
          sessionDir,
        },
      },
    ]);
    // Checked once, then forgotten.
    expect(await f.core.commands.checkPendingSessionFiles()).toBe(0);
    expect(JSON.stringify(f.logger.lines)).not.toContain("do the thing");
  });

  it("stays quiet when the harness created the file, and logs resume on the next launch", async () => {
    const f = await fixture();
    const launch = await f.core.commands.claimSessionLaunch(f.task.id);
    if (launch?.mode !== "new") throw new Error("expected a new launch");
    const dir = piSessionDir(f.cwd, f.agentDir);
    await mkdir(dir, { recursive: true });
    const file = join(
      dir,
      `2026-01-01T00-00-00-000Z_${launch.sessionId}.jsonl`,
    );
    await writeFile(file, "{}\n");
    expect(
      await f.core.commands.recordTaskSession(f.task.id, {
        sessionId: launch.sessionId,
        sessionPath: file,
      }),
    ).toBe(true);
    expect(f.logger.find("recorded session report")[0]?.fields).toMatchObject({
      sessionId: launch.sessionId,
      sessionFile: file,
      outcome: "recorded",
    });

    f.clock.ms += SESSION_FILE_GRACE_MS + 1;
    expect(await f.core.commands.checkPendingSessionFiles()).toBe(0);
    expect(f.logger.find("no session file")).toEqual([]);

    await f.core.commands.claimSessionLaunch(f.task.id);
    expect(f.logger.find("launch resume")[0]?.fields).toMatchObject({
      mode: "resume",
      sessionId: launch.sessionId,
      sessionFile: file,
    });
  });
});

describe("rules-file problems", () => {
  it("are logged once as warnings with the file and rule id", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    await mkdir(join(stateDir, "rules"), { recursive: true });
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({ automation: true, codeRoot: join(root, "Code") }),
    );
    const rulesFile = join(stateDir, "rules", "rules.yaml");
    await writeFile(
      rulesFile,
      [
        "rules:",
        "  - id: stale-dev",
        "    label: Stale",
        "    on: github.pr.merged",
        '    if: task.state == "dev"',
        "    do:",
        "      - action: move",
        "        with: { to: done }",
        "",
      ].join("\n"),
    );
    const logger = captureLogger();
    const core = createCore({
      stateDir,
      logger,
      versions: { fetchText: async () => "" },
    });
    await core.commands.listRules();
    await core.commands.listRules();
    const lines = logger.lines.filter((line) => line.scope === "rules");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      fields: { file: rulesFile, ruleId: "stale-dev" },
    });
    expect(lines[0]?.message).toContain('"dev"');
  });
});
