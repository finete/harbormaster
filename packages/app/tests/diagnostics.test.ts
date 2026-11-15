import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import type { BoardColumn, WorkspaceBinding } from "@harbormaster/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDiagnosticsState,
  buildDiagnosticsZip,
  buildEnvironmentInfo,
  buildTasksSummary,
  type DiagnosticsStateCommands,
  diagnosticsFileName,
  extensionFileInfo,
  REDACTED,
  redactConfig,
  redactString,
  replaceHomeDir,
  type TasksSummaryCommands,
} from "../src/main/diagnostics";
import {
  collectLogTail,
  logKind,
  rotatedLogFiles,
} from "../src/main/diagnostics-limits";
import { crc32, createZip } from "../src/main/zip-writer";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hm-diagnostics-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function unzipList(zipPath: string): string[] {
  return execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .trim()
    .split("\n");
}

function unzipRead(zipPath: string, name: string): string {
  return execFileSync("unzip", ["-p", zipPath, name], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe("redactString", () => {
  it("strips credentials embedded in URLs", () => {
    expect(redactString("https://alice:hunter2@github.com/acme/app.git")).toBe(
      `https://${REDACTED}@github.com/acme/app.git`,
    );
    expect(redactString("https://x-access-token@ghe.example/acme")).toBe(
      `https://${REDACTED}@ghe.example/acme`,
    );
    expect(
      redactString("https://deploy.example/version?token=abc123&x=1"),
    ).toBe(`https://deploy.example/version?token=${REDACTED}&x=1`);
  });

  it("redacts known token shapes anywhere in text", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactString(`export GH=${token} done`)).toBe(
      `export GH=${REDACTED} done`,
    );
    expect(redactString(`key sk-ant-${"b".repeat(30)}`)).toBe(
      `key ${REDACTED}`,
    );
  });

  it("leaves ordinary URLs and paths alone", () => {
    for (const plain of [
      "https://deploy.example/version.txt",
      "/Users/alice/Code",
      "git@github.com:acme/app.git",
    ]) {
      expect(redactString(plain)).toBe(plain);
    }
  });
});

describe("redactConfig", () => {
  it("redacts secret-named keys deeply and keeps the rest readable", () => {
    const config = {
      automation: true,
      codeRoot: "/Users/alice/Code",
      repositories: {
        "github.com/acme/app": {
          deployment: [
            {
              name: "staging",
              versionUrl: "https://bob:pw@staging.example/version",
            },
          ],
          githubToken: "anything",
        },
      },
      addons: { slack: { apiKey: "xyz", webhook: { secret: 42 } } },
      launch: { maxConcurrent: 6 },
    };
    expect(redactConfig(config)).toEqual({
      automation: true,
      codeRoot: "/Users/alice/Code",
      repositories: {
        "github.com/acme/app": {
          deployment: [
            {
              name: "staging",
              versionUrl: `https://${REDACTED}@staging.example/version`,
            },
          ],
          githubToken: REDACTED,
        },
      },
      addons: { slack: { apiKey: REDACTED, webhook: { secret: REDACTED } } },
      launch: { maxConcurrent: 6 },
    });
  });
});

describe("zip writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("writes an archive unzip can list, test and extract", () => {
    const dir = tempDir();
    const zipPath = path.join(dir, "out.zip");
    const big = "harbor ".repeat(10_000); // compressible: deflated
    const random = Buffer.from(
      Array.from({ length: 512 }, (_, i) => (i * 7919) % 251),
    ); // short, stored
    writeFileSync(
      zipPath,
      createZip([
        { name: "a.txt", data: "hello" },
        { name: "nested/big.txt", data: big },
        { name: "bin.dat", data: random },
        { name: "empty.txt", data: "" },
      ]),
    );
    execFileSync("unzip", ["-tq", zipPath]);
    expect(unzipList(zipPath)).toEqual([
      "a.txt",
      "nested/big.txt",
      "bin.dat",
      "empty.txt",
    ]);
    expect(unzipRead(zipPath, "a.txt")).toBe("hello");
    expect(unzipRead(zipPath, "nested/big.txt")).toBe(big);
  });
});

describe("buildDiagnosticsZip", () => {
  it("bundles logs, the redacted config, versions and the rules list", () => {
    const dir = tempDir();
    const logsDir = path.join(dir, "logs");
    mkdirSync(path.join(logsDir, "old"), { recursive: true });
    writeFileSync(path.join(logsDir, "wake.log"), "power: resume\n");
    writeFileSync(path.join(logsDir, "old", "ignored.log"), "nested\n");
    const configFile = path.join(dir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ automation: true, token: "s3cret" }),
    );
    const zipPath = path.join(dir, diagnosticsFileName(new Date(0)));
    writeFileSync(
      zipPath,
      buildDiagnosticsZip({
        logsDir,
        configFile,
        versions: { app: "1.2.3", electron: "33.3.1", node: "20.18.1" },
        rulesList: "review-changes-requested\n",
        now: new Date(0),
      }),
    );

    expect(path.basename(zipPath)).toBe(
      "harbormaster-diagnostics-1970-01-01-00-00-00.zip",
    );
    expect(unzipList(zipPath).sort()).toEqual([
      "config.redacted.json",
      "logs/README.txt",
      "logs/wake.log",
      "manifest.json",
      "rules-list.txt",
      "versions.json",
    ]);
    expect(JSON.parse(unzipRead(zipPath, "config.redacted.json"))).toEqual({
      automation: true,
      token: REDACTED,
    });
    expect(JSON.parse(unzipRead(zipPath, "versions.json"))).toMatchObject({
      app: "1.2.3",
      electron: "33.3.1",
      node: "20.18.1",
      exportedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(unzipRead(zipPath, "logs/wake.log")).toBe("power: resume\n");
  });

  it("describes a missing config and logs dir instead of failing", () => {
    const dir = tempDir();
    const zipPath = path.join(dir, "d.zip");
    writeFileSync(
      zipPath,
      buildDiagnosticsZip({
        logsDir: path.join(dir, "nope"),
        configFile: path.join(dir, "missing.json"),
        versions: {},
      }),
    );
    expect(unzipList(zipPath).sort()).toEqual([
      "config.redacted.json",
      "logs/README.txt",
      "manifest.json",
      "versions.json",
    ]);
    expect(unzipRead(zipPath, "config.redacted.json")).toMatch(
      /does not exist/,
    );
    expect(unzipRead(zipPath, "logs/README.txt")).toMatch(
      /No log files were found/,
    );
  });

  it("bundles tasks-summary.json and environment.json when provided", () => {
    const dir = tempDir();
    const zipPath = path.join(dir, "d.zip");
    writeFileSync(
      zipPath,
      buildDiagnosticsZip({
        logsDir: path.join(dir, "nope"),
        configFile: path.join(dir, "missing.json"),
        versions: {},
        tasksSummary: [
          {
            id: "t1",
            kind: "standalone",
            state: "working",
            title: "Fix it",
            hasPr: false,
          },
        ],
        environment: buildEnvironmentInfo({
          app: "1.0.0",
          electron: "30.0.0",
          node: "20.0.0",
          platform: "darwin",
          path: "/usr/bin",
          pi: {},
          claude: {},
        }),
      }),
    );
    expect(unzipList(zipPath).sort()).toEqual([
      "config.redacted.json",
      "environment.json",
      "logs/README.txt",
      "manifest.json",
      "tasks-summary.json",
      "versions.json",
    ]);
    expect(JSON.parse(unzipRead(zipPath, "tasks-summary.json"))).toEqual([
      {
        id: "t1",
        kind: "standalone",
        state: "working",
        title: "Fix it",
        hasPr: false,
      },
    ]);
    expect(JSON.parse(unzipRead(zipPath, "environment.json")).app).toBe(
      "1.0.0",
    );
  });
});

function fakeTask(overrides: Record<string, unknown> = {}): BoardColumn[] {
  return [
    {
      state: "working",
      title: "Working",
      groups: [
        {
          id: "g1",
          tasks: [
            {
              id: "t1",
              kind: "standalone",
              state: "working",
              title: "Fix the bug",
              initialPrompt: "do not leak this prompt text",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
              stateChangedAt: "2024-01-01T00:00:00.000Z",
              ...overrides,
            },
          ],
        },
      ],
    },
  ] as unknown as BoardColumn[];
}

describe("buildTasksSummary", () => {
  it("summarizes every task with its binding, never prompt text", async () => {
    const binding: WorkspaceBinding = {
      id: "b1",
      taskId: "t1",
      worktreePath: "/work/t1",
      sessionId: "sess-1",
      sessionPath: "/sessions/sess-1.jsonl",
      detached: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const commands: TasksSummaryCommands = {
      listBoard: async () =>
        fakeTask({
          harness: "pi",
          model: "opus",
          pr: { url: "https://github.com/x/y/pull/1" },
          launch: {
            status: "started",
            requestedAt: "2024-01-01T00:00:00.000Z",
          },
        }),
      getTaskWorkspace: async (taskId) =>
        taskId === "t1" ? binding : undefined,
    };
    const summary = await buildTasksSummary(commands);
    expect(summary).toEqual([
      {
        id: "t1",
        kind: "standalone",
        state: "working",
        title: "Fix the bug",
        hasPr: true,
        harness: "pi",
        model: "opus",
        launch: { status: "started", requestedAt: "2024-01-01T00:00:00.000Z" },
        binding: {
          worktreePath: "/work/t1",
          sessionId: "sess-1",
          hasSessionPath: true,
        },
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain("leak this prompt");
  });

  it("tolerates a getTaskWorkspace failure (parked/scratch tasks)", async () => {
    const commands: TasksSummaryCommands = {
      listBoard: async () => fakeTask(),
      getTaskWorkspace: async () => {
        throw new Error("nope");
      },
    };
    const summary = await buildTasksSummary(commands);
    expect(summary[0]?.binding).toBeUndefined();
  });
});

describe("extensionFileInfo", () => {
  it("returns name/mtime/size for an existing file", () => {
    const dir = tempDir();
    const file = path.join(dir, "harbormaster-inbox.ts");
    writeFileSync(file, "// extension");
    const info = extensionFileInfo(file);
    expect(info?.name).toBe("harbormaster-inbox.ts");
    expect(info?.size).toBeGreaterThan(0);
    expect(() => new Date(info?.mtime ?? "")).not.toThrow();
  });

  it("returns undefined for a missing file", () => {
    expect(extensionFileInfo("/does/not/exist")).toBeUndefined();
  });
});

describe("buildEnvironmentInfo", () => {
  it("assembles versions, PATH, agent resolution and the extension's stat", () => {
    const dir = tempDir();
    const extFile = path.join(dir, "harbormaster-inbox.ts");
    writeFileSync(extFile, "// v1");
    const info = buildEnvironmentInfo({
      app: "1.2.3",
      electron: "30.0.0",
      node: "20.0.0",
      platform: "darwin",
      path: "/usr/bin:/bin",
      shell: "/bin/zsh",
      pi: { resolved: "/usr/local/bin/pi", version: "pi 1.0.0" },
      claude: { resolved: undefined, version: undefined },
      piExtensionPath: extFile,
    });
    expect(info.app).toBe("1.2.3");
    expect(info.path).toBe("/usr/bin:/bin");
    expect(info.shell).toBe("/bin/zsh");
    expect(info.pi.resolved).toBe("/usr/local/bin/pi");
    expect(info.piExtension?.name).toBe("harbormaster-inbox.ts");
  });

  it("omits piExtension when the path doesn't resolve to a file", () => {
    const info = buildEnvironmentInfo({
      app: "1.2.3",
      electron: "30.0.0",
      node: "20.0.0",
      platform: "darwin",
      path: "",
      pi: {},
      claude: {},
      piExtensionPath: "/does/not/exist",
    });
    expect(info.piExtension).toBeUndefined();
  });
});

const NOW = new Date("2024-06-02T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (msAgo: number): string =>
  new Date(NOW.getTime() - msAgo).toISOString();

function fakeFiles(
  files: Record<string, string>,
): (p: string) => string | undefined {
  return (p) => files[p];
}

describe("collectLogTail", () => {
  it("reads rotations newest-first and returns records oldest-first", () => {
    const read = fakeFiles({
      "main.log": `${iso(1 * HOUR)} [LOG] c\n${iso(0)} [LOG] d\n`,
      "main.1.log": `${iso(3 * HOUR)} [LOG] a\n${iso(2 * HOUR)} [LOG] b\n`,
    });
    const tail = collectLogTail(["main.log", "main.1.log", "main.2.log"], {
      maxBytes: 1_000_000,
      lookbackMs: 24 * HOUR,
      now: NOW,
      read,
    });
    expect(
      tail.text
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(-1)),
    ).toEqual(["a", "b", "c", "d"]);
    expect(tail.filesRead).toEqual(["main.log", "main.1.log"]);
    expect(tail.truncated).toBe(false);
    expect(tail.droppedLines).toBe(0);
    expect(tail.oldestKept).toBe(iso(3 * HOUR));
    expect(tail.newestKept).toBe(iso(0));
  });

  it("cuts at the lookback window", () => {
    const tail = collectLogTail(["main.log", "main.1.log"], {
      maxBytes: 1_000_000,
      lookbackMs: 24 * HOUR,
      now: NOW,
      read: fakeFiles({
        "main.log": `${iso(23 * HOUR)} [LOG] recent\n`,
        "main.1.log": `${iso(30 * HOUR)} [LOG] old1\n  trace\n${iso(25 * HOUR)} [LOG] old2\n`,
      }),
    });
    expect(tail.text).toBe(`${iso(23 * HOUR)} [LOG] recent\n`);
    expect(tail.truncated).toBe(true);
    expect(tail.truncatedBy).toBe("lookback");
    expect(tail.droppedLines).toBe(3);
  });

  it("stops at the byte budget, keeping the newest whole records", () => {
    const line = (n: number): string => `${iso(n * 1000)} [LOG] line-${n}`;
    const content = `${[5, 4, 3, 2, 1].map(line).join("\n")}\n`;
    const budget = Buffer.byteLength(`${line(2)}\n${line(1)}\n`) + 5;
    const tail = collectLogTail(["main.log"], {
      maxBytes: budget,
      lookbackMs: 24 * HOUR,
      now: NOW,
      read: fakeFiles({ "main.log": content }),
    });
    expect(tail.text).toBe(`${line(2)}\n${line(1)}\n`);
    expect(tail.truncatedBy).toBe("budget");
    expect(tail.droppedLines).toBe(3);
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(budget);
  });

  it("keeps the tail of a single newest record larger than the budget", () => {
    const tail = collectLogTail(["main.log"], {
      maxBytes: 8,
      lookbackMs: 24 * HOUR,
      now: NOW,
      read: fakeFiles({ "main.log": `${iso(0)} ${"x".repeat(50)}END\n` }),
    });
    expect(tail.text).toBe("xxxxEND\n");
    expect(tail.truncated).toBe(true);
  });

  it("attaches untimestamped lines to the previous record, across rotations", () => {
    const tail = collectLogTail(["main.log", "main.1.log"], {
      maxBytes: 1_000_000,
      lookbackMs: 24 * HOUR,
      now: NOW,
      read: fakeFiles({
        // main.log starts mid-record: the stack continues main.1.log's last line.
        "main.log": `    at frame2\n${iso(0)} [LOG] after\n`,
        "main.1.log": `${iso(30 * HOUR)} [LOG] too old\n${iso(HOUR)} [ERROR] boom\n    at frame1\n`,
      }),
    });
    expect(tail.text).toBe(
      `${iso(HOUR)} [ERROR] boom\n    at frame1\n    at frame2\n${iso(0)} [LOG] after\n`,
    );
    expect(tail.keptLines).toBe(4);
    expect(tail.droppedLines).toBe(1);
    // A record is never split by the budget: the stack goes with its head.
    const small = collectLogTail(["main.log", "main.1.log"], {
      maxBytes: Buffer.byteLength(`${iso(0)} [LOG] after\n`) + 10,
      lookbackMs: 24 * HOUR,
      now: NOW,
      read: fakeFiles({
        "main.log": `    at frame2\n${iso(0)} [LOG] after\n`,
        "main.1.log": `${iso(HOUR)} [ERROR] boom\n    at frame1\n`,
      }),
    });
    expect(small.text).toBe(`${iso(0)} [LOG] after\n`);
    expect(small.droppedLines).toBe(3);
  });

  it("applies the transform before measuring", () => {
    const tail = collectLogTail(["wake.log"], {
      maxBytes: 1_000,
      lookbackMs: 24 * HOUR,
      now: NOW,
      transform: (text) => text.replace("secret", "[x]"),
      read: fakeFiles({ "wake.log": `${iso(0)} secret\n` }),
    });
    expect(tail.text).toBe(`${iso(0)} [x]\n`);
  });
});

describe("logKind / rotatedLogFiles", () => {
  it("groups both rotation styles newest-first", () => {
    expect(logKind("main.log")).toEqual({ base: "main.log", index: 0 });
    expect(logKind("main.2.log")).toEqual({ base: "main.log", index: 2 });
    expect(logKind("wake.log.1")).toEqual({ base: "wake.log", index: 1 });
    expect(logKind("notes.txt")).toBeUndefined();
    const dir = tempDir();
    for (const name of [
      "main.2.log",
      "main.log",
      "main.1.log",
      "wake.log.1",
      "wake.log",
      "x.txt",
    ]) {
      writeFileSync(path.join(dir, name), "");
    }
    const kinds = rotatedLogFiles(dir);
    expect([...kinds.keys()]).toEqual(["main.log", "wake.log"]);
    expect(kinds.get("main.log")?.map((p) => path.basename(p))).toEqual([
      "main.log",
      "main.1.log",
      "main.2.log",
    ]);
    expect(kinds.get("wake.log")?.map((p) => path.basename(p))).toEqual([
      "wake.log",
      "wake.log.1",
    ]);
  });
});

describe("replaceHomeDir", () => {
  it("replaces whole home path segments only, idempotently", () => {
    const home = "/Users/alice";
    const text = `/Users/alice/Code and /Users/alice. and "/Users/alice" but /Users/alicette/x and /Users/alice.bak`;
    const once = replaceHomeDir(text, home);
    expect(once).toBe(
      `~/Code and ~. and "~" but /Users/alicette/x and /Users/alice.bak`,
    );
    expect(replaceHomeDir(once, home)).toBe(once);
    expect(replaceHomeDir(text, `${home}/`)).toBe(once);
  });

  it("handles JSON-escaped Windows homes and ignores degenerate homes", () => {
    const home = "C:\\Users\\bob";
    const jsonText = JSON.stringify({ p: "C:\\Users\\bob\\x" });
    expect(replaceHomeDir(jsonText, home)).toBe('{"p":"~\\\\x"}');
    expect(replaceHomeDir("/a/b", "/")).toBe("/a/b");
  });
});

function unzipAll(zipPath: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of unzipList(zipPath))
    out.set(name, unzipRead(zipPath, name));
  return out;
}

function writeBundle(input: Parameters<typeof buildDiagnosticsZip>[0]): string {
  const zipPath = path.join(tempDir(), "bundle.zip");
  writeFileSync(zipPath, buildDiagnosticsZip(input));
  return zipPath;
}

describe("buildDiagnosticsZip manifest, limits and home replacement", () => {
  const home = os.homedir();
  const username = os.userInfo().username;

  function fixture(): { logsDir: string; configFile: string } {
    const dir = tempDir();
    const logsDir = path.join(dir, "logs");
    mkdirSync(logsDir);
    writeFileSync(
      path.join(logsDir, "main.log"),
      `${iso(HOUR)} [LOG] cwd ${home}/Code/app token ghp_${"a".repeat(36)}\n${iso(0)} [ERROR] failed in ${home}/x\n    at ${home}/frame.js:1\n`,
    );
    writeFileSync(
      path.join(logsDir, "main.1.log"),
      `${iso(48 * HOUR)} [LOG] ancient\n${iso(2 * HOUR)} [LOG] rotated\n`,
    );
    writeFileSync(path.join(logsDir, "wake.log"), `${iso(0)} power: resume\n`);
    const configFile = path.join(dir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ codeRoot: `${home}/Code`, githubToken: "s3cret" }),
    );
    return { logsDir, configFile };
  }

  const fullInput = () => ({
    ...fixture(),
    versions: { app: "9.9.9", cwd: `${home}/Code` },
    rulesList: `rules in ${home}/.harbormaster/rules\n`,
    tasksSummary: [
      {
        id: "t1",
        kind: "standalone",
        state: "working",
        title: "x",
        hasPr: false,
        binding: { worktreePath: `${home}/w/t1`, hasSessionPath: true },
      },
    ],
    environment: buildEnvironmentInfo({
      app: "9.9.9",
      electron: "30.0.0",
      node: "20.0.0",
      platform: "darwin",
      path: `${home}/bin:/usr/bin`,
      shell: "/bin/zsh",
      pi: { resolved: `${home}/.local/bin/pi` },
      claude: {},
    }),
    now: NOW,
  });

  it("writes a manifest with a random bundle id, sizes and limits", () => {
    const input = fullInput();
    const a = unzipAll(writeBundle(input));
    const b = unzipAll(writeBundle(input));
    const manifest = JSON.parse(a.get("manifest.json") ?? "");
    const other = JSON.parse(b.get("manifest.json") ?? "");
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.bundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(other.bundleId).not.toBe(manifest.bundleId);
    expect(manifest.exportedAt).toBe(NOW.toISOString());
    expect(manifest.appVersion).toBe("9.9.9");
    expect(manifest.homeReplaced).toBe(true);
    expect(manifest.limits).toMatchObject({
      lookbackMs: 24 * HOUR,
      mainLogBytes: 3 * 1024 * 1024,
      wakeLogBytes: 256 * 1024,
      bundleBytes: 8 * 1024 * 1024,
    });
    expect(manifest.lastUncleanExit).toBeUndefined();
    const names = [...a.keys()].filter((n) => n !== "manifest.json").sort();
    expect(manifest.files.map((f: { name: string }) => f.name).sort()).toEqual(
      names,
    );
    for (const file of manifest.files as Array<{
      name: string;
      bytes: number;
    }>) {
      expect(file.bytes).toBe(Buffer.byteLength(a.get(file.name) ?? ""));
    }
    expect(manifest.logs["main.log"]).toMatchObject({
      files: ["main.log", "main.1.log"],
      keptLines: 4,
      droppedLines: 1,
      truncated: true,
      truncatedBy: "lookback",
      newestKept: iso(0),
      oldestKept: iso(2 * HOUR),
    });
    // Logs are tails: the record outside the lookback is gone, redaction reapplied.
    const mainLog = a.get("logs/main.log") ?? "";
    expect(mainLog).not.toContain("ancient");
    expect(mainLog).toContain("rotated");
    expect(mainLog).not.toContain("ghp_");
    expect(mainLog).toContain("~/Code/app");
    expect(a.get("logs/README.txt")).toMatch(/last 24 hours/);
    expect(a.get("logs/README.txt")).toMatch(
      /main\.log: .*truncated \(lookback\)/s,
    );
  });

  it("leaves no home path or username anywhere in the bundle", () => {
    const all = unzipAll(writeBundle(fullInput()));
    const text = [...all.values()].join("\n");
    expect(text).toContain("~/");
    expect(text).not.toContain(home);
    // A very short username could collide with ordinary words; skip then.
    if (username.length >= 3) expect(text).not.toContain(username);
  });

  it("keeps the home path when replacement is off", () => {
    const all = unzipAll(writeBundle({ ...fullInput(), replaceHome: false }));
    expect(JSON.parse(all.get("manifest.json") ?? "").homeReplaced).toBe(false);
    expect(all.get("logs/main.log")).toContain(home);
  });

  it("writes optional doctor, crash reports and last unclean exit only when given", () => {
    const base = fullInput();
    const without = unzipAll(writeBundle(base));
    expect(without.has("doctor.json")).toBe(false);
    expect(without.has("crash-reports.json")).toBe(false);
    const withAll = unzipAll(
      writeBundle({
        ...base,
        doctor: {
          checks: [{ id: "gh", ok: true, detail: `${home}/x` }],
          token: "abc",
        },
        crashReports: [
          { name: "Harbormaster-2024-06-01.ips", mtime: iso(HOUR) },
        ],
        lastUncleanExit: { at: iso(HOUR), pid: 42 },
      }),
    );
    expect(JSON.parse(withAll.get("doctor.json") ?? "")).toEqual({
      checks: [{ id: "gh", ok: true, detail: "~/x" }],
      token: REDACTED,
    });
    expect(JSON.parse(withAll.get("crash-reports.json") ?? "")).toEqual([
      { name: "Harbormaster-2024-06-01.ips", mtime: iso(HOUR) },
    ]);
    expect(
      JSON.parse(withAll.get("manifest.json") ?? "").lastUncleanExit,
    ).toEqual({
      at: iso(HOUR),
      pid: 42,
    });
  });

  it("caps the whole bundle", () => {
    const { logsDir, configFile } = fixture();
    const record = (i: number): string =>
      `${iso(i)} [LOG] ${"y".repeat(200)}\n`;
    const big = Array.from({ length: 30_000 }, (_, i) =>
      record(30_000 - i),
    ).join("");
    writeFileSync(path.join(logsDir, "main.log"), big);
    writeFileSync(path.join(logsDir, "wake.log"), big);
    writeFileSync(path.join(logsDir, "core.log"), big);
    const bundleBytes = 2 * 1024 * 1024;
    const all = unzipAll(
      writeBundle({
        logsDir,
        configFile,
        versions: {},
        doctor: Array.from({ length: 20_000 }, (_, i) => ({
          i,
          pad: "z".repeat(40),
        })),
        limits: { bundleBytes },
        now: NOW,
      }),
    );
    const manifest = JSON.parse(all.get("manifest.json") ?? "");
    const total = [...all.values()].reduce(
      (sum, t) => sum + Buffer.byteLength(t),
      0,
    );
    expect(total).toBeLessThanOrEqual(bundleBytes);
    expect(manifest.totalBytes).toBeLessThanOrEqual(bundleBytes);
    expect(
      Buffer.byteLength(all.get("logs/wake.log") ?? ""),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(manifest.logs["wake.log"].truncatedBy).toBe("budget");
    expect(manifest.logs["main.log"].truncatedBy).toBe("budget");
    // doctor.json was oversized: an array keeps its leading items, still valid JSON.
    const doctor = JSON.parse(all.get("doctor.json") ?? "");
    expect(doctor.length).toBeGreaterThan(0);
    expect(doctor.length).toBeLessThan(20_000);
    expect(
      manifest.files.find((f: { name: string }) => f.name === "doctor.json")
        .truncated,
    ).toBe(true);
  });
});

describe("buildDiagnosticsState", () => {
  const binding: WorkspaceBinding = {
    id: "b1",
    taskId: "t1",
    worktreePath: "/work/t1",
    branch: "hm/t1",
    sessionId: "sess-1",
    sessionPath: "/sessions/sess-1.jsonl",
    detached: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  const commands = (
    overrides: Partial<DiagnosticsStateCommands> = {},
  ): DiagnosticsStateCommands => ({
    listBoard: async () =>
      fakeTask({
        pr: { number: 7, state: "open", url: "https://github.com/x/y/pull/7" },
        launch: { status: "started", requestedAt: "2024-01-01T00:00:00.000Z" },
        lastError: `failed with ghp_${"c".repeat(36)}`,
      }),
    getTaskWorkspace: async () => binding,
    getPresence: async () => ({
      live: true,
      runningTurn: false,
      record: {
        taskId: "t1",
        sessionPath: "/sessions/sess-1.jsonl",
        pid: 99,
        mode: "interactive",
        startedAt: "2024-01-01T00:00:00.000Z",
        heartbeatAt: "2024-01-01T00:00:01.000Z",
        outcome: {
          status: "blocked",
          note: "agent note body",
          at: "2024-01-01T00:00:02.000Z",
        },
        status: {
          state: "error",
          message: "status message body",
          at: "2024-01-01T00:00:03.000Z",
        },
      },
    }),
    listLocations: async () => [{ path: "/work/folder", name: "folder" }],
    listRepositories: async () => [
      {
        id: "github.com/x/y",
        root: "/code/y",
        defaultBranch: "main",
        remoteUrl: "https://bob:pw@github.com/x/y.git",
        checkouts: [{ root: "/code/y", isPrimary: true }],
      },
    ],
    getMessagingStates: async () => [
      {
        taskId: "t1",
        waitingOnParent: { messageId: "m1", question: "secret question body" },
        approvalsWaiting: 1,
      },
    ],
    ...overrides,
  });

  it("keeps ids, states, timestamps, launch, pr and binding; drops prompts and message bodies", async () => {
    const state = await buildDiagnosticsState(commands());
    const [entry] = state.tasks ?? [];
    expect(entry?.task).toMatchObject({
      id: "t1",
      state: "working",
      hasInitialPrompt: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      launch: { status: "started" },
      pr: { number: 7, state: "open" },
      lastError: `failed with ${REDACTED}`,
    });
    expect(entry?.binding).toMatchObject({
      worktreePath: "/work/t1",
      branch: "hm/t1",
      sessionId: "sess-1",
      sessionPath: "/sessions/sess-1.jsonl",
    });
    expect(entry?.presence).toMatchObject({
      live: true,
      record: {
        pid: 99,
        outcome: { status: "blocked" },
        status: { state: "error", hasMessage: true },
      },
    });
    expect(state.locations).toEqual([{ path: "/work/folder", name: "folder" }]);
    expect(state.repositories?.[0]?.remoteUrl).toBe(
      `https://${REDACTED}@github.com/x/y.git`,
    );
    expect(state.messaging).toEqual([
      {
        taskId: "t1",
        waitingOnParent: { messageId: "m1" },
        approvalsWaiting: 1,
      },
    ]);
    expect(state.errors).toEqual({});

    const zip = unzipAll(
      writeBundle({
        logsDir: path.join(tempDir(), "none"),
        configFile: path.join(tempDir(), "none.json"),
        versions: {},
        state,
      }),
    );
    expect(
      [...zip.keys()].filter((n) => n.startsWith("state/")).sort(),
    ).toEqual([
      "state/locations.json",
      "state/messaging.json",
      "state/repositories.json",
      "state/tasks.json",
    ]);
    const text = [...zip.values()].join("\n");
    for (const body of [
      "leak this prompt",
      "agent note body",
      "status message body",
      "secret question body",
      "bob:pw",
    ]) {
      expect(text).not.toContain(body);
    }
  });

  it("records failing or hanging commands instead of throwing", async () => {
    const state = await buildDiagnosticsState(
      commands({
        listRepositories: () => new Promise(() => {}),
        listLocations: async () => {
          throw new Error("boom");
        },
        getPresence: async () => {
          throw new Error("no presence");
        },
      }),
      20,
    );
    expect(state.errors).toEqual({
      listRepositories: "timed out after 20ms",
      listLocations: "boom",
    });
    expect(state.repositories).toBeUndefined();
    expect(state.tasks?.[0]?.presence).toBeUndefined();
    const zip = unzipAll(
      writeBundle({
        logsDir: path.join(tempDir(), "none"),
        configFile: path.join(tempDir(), "none.json"),
        versions: {},
        state,
      }),
    );
    expect(JSON.parse(zip.get("manifest.json") ?? "").stateErrors).toEqual(
      state.errors,
    );
  });
});
