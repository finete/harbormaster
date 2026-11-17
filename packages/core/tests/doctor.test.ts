// `harbormaster doctor`: the pure verdicts (engines/doctor.ts), the Pi
// extension comparison (utilities/pi-extension.ts), and the `doctor`
// command end to end on a temp state dir with fake machine probes — read
// only (a missing config is reported, never written) and never throwing.

import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEnvironmentProbeAccess } from "../src/access/local-environment-probe-access.js";
import {
  type DoctorReport,
  type EnvironmentProbeAccess,
  LOCAL_PROBE_TIMEOUT_MS,
  NETWORK_PROBE_CONCURRENCY,
  NETWORK_PROBE_TIMEOUT_MS,
  type RemoteProbe,
} from "../src/contracts/doctor.js";
import type { ProbeOutcome } from "../src/contracts/onboarding.js";
import type { RuleFile } from "../src/contracts/rules.js";
import {
  classifyRemoteProbe,
  codeRootCheck,
  commandCheck,
  DISK_FAIL_BYTES,
  DISK_WARN_BYTES,
  discoveredCheck,
  diskCheck,
  doctorExitCode,
  doctorPlainSummary,
  formatDoctorReport,
  githubAuthCheck,
  githubReachability,
  loginShellPathCheck,
  missingPathEntries,
  orderDoctorChecks,
  orphansCheck,
  piExtensionCheck,
  REMOTE_TIMEOUT_REMEDIATION,
  remoteCheck,
  rulesCheck,
  selectRemoteProbes,
  socketCheck,
  stateFileCheck,
  versionEndpointCheck,
  versionEndpointTargets,
} from "../src/engines/doctor.js";
import { createCore } from "../src/index.js";
import { DoctorRuntime } from "../src/manager/doctor-runtime.js";
import {
  comparePiExtension,
  resolvePiExtensionsDir,
} from "../src/utilities/pi-extension.js";
import {
  type ProcessRunRequest,
  setProcessRunner,
} from "../src/utilities/run.js";
import { resolveStatePaths } from "../src/utilities/state-paths.js";

const ok = (output = ""): ProbeOutcome => ({
  ok: true,
  output,
  notFound: false,
  timedOut: false,
});
const failed = (output = ""): ProbeOutcome => ({
  ok: false,
  output,
  notFound: false,
  timedOut: false,
});
const notFound: ProbeOutcome = {
  ok: false,
  output: "",
  notFound: true,
  timedOut: false,
};
const timedOut: ProbeOutcome = {
  ok: false,
  output: "",
  notFound: false,
  timedOut: true,
};

const ext = (version: number, body = "x"): string =>
  `export const HARBORMASTER_INBOX_EXTENSION_VERSION = ${version};\n${body}\n`;

describe("commandCheck", () => {
  const base = {
    id: "agents.pi",
    label: "Pi",
    command: "pi",
    whenMissing: "fail" as const,
    install: "npm i -g pi",
  };

  it("ok with the version and the resolved path", () => {
    const check = commandCheck({
      ...base,
      resolved: "/opt/bin/pi",
      outcome: ok("pi 1.3.0\n"),
    });
    expect(check).toMatchObject({
      group: "agents",
      id: "agents.pi",
      status: "ok",
      summary: "Pi 1.3.0",
      detail: "/opt/bin/pi",
    });
  });

  it("missing: the configured severity plus how to install", () => {
    expect(commandCheck({ ...base, outcome: notFound })).toMatchObject({
      status: "fail",
      summary: "Pi is not on PATH",
      remediation: "npm i -g pi",
    });
    expect(
      commandCheck({ ...base, whenMissing: "warn", outcome: notFound }).status,
    ).toBe("warn");
  });

  it("a timeout is skip, a failing --version is warn", () => {
    expect(
      commandCheck({ ...base, resolved: "/x/pi", outcome: timedOut }).status,
    ).toBe("skip");
    expect(
      commandCheck({ ...base, resolved: "/x/pi", outcome: failed("boom") }),
    ).toMatchObject({ status: "warn", detail: "/x/pi\nboom" });
  });
});

describe("githubAuthCheck (exit code, plus reachability)", () => {
  it("maps the exit code, whatever gh printed", () => {
    expect(githubAuthCheck(ok("anything"), true)).toMatchObject({
      status: "ok",
      summary: "gh is logged in (api.github.com reachable)",
    });
    expect(githubAuthCheck(ok(), true, 412.4).summary).toBe(
      "gh is logged in (api.github.com reachable, 412 ms)",
    );
    expect(
      githubAuthCheck(failed("Logged in to github.com account x"), true),
    ).toMatchObject({ status: "fail", summary: "gh is not logged in" });
    expect(githubAuthCheck(failed(), false).status).toBe("warn");
    expect(githubAuthCheck(notFound, true).status).toBe("skip");
  });

  it("a timeout or a network error is warn: api.github.com unreachable", () => {
    expect(githubAuthCheck(timedOut, true)).toMatchObject({
      status: "warn",
      summary:
        "gh auth status did not answer within 20 s (api.github.com unreachable)",
    });
    const offline = failed(
      "X Failed to log in to github.com: dial tcp: lookup api.github.com: no such host",
    );
    expect(githubAuthCheck(offline, true)).toMatchObject({
      status: "warn",
      summary: "gh could not reach api.github.com",
    });
    expect(githubReachability(ok())).toBe("reachable");
    expect(githubReachability(timedOut)).toBe("unreachable");
    expect(githubReachability(offline)).toBe("unreachable");
    expect(githubReachability(failed("not logged in"))).toBe("unknown");
    expect(githubReachability(notFound)).toBe("unknown");
  });
});

describe("Pi extension", () => {
  it("resolves the extensions dir like the installer", () => {
    expect(
      resolvePiExtensionsDir({ HARBORMASTER_PI_EXTENSIONS_DIR: "/x" }, "/h"),
    ).toBe("/x");
    expect(resolvePiExtensionsDir({ PI_CODING_AGENT_DIR: "/a" }, "/h")).toBe(
      "/a/extensions",
    );
    expect(resolvePiExtensionsDir({}, "/h")).toBe("/h/.pi/agent/extensions");
  });

  it("compares installed vs bundled", () => {
    expect(comparePiExtension(undefined, ext(2))).toBe("missing");
    expect(comparePiExtension("no marker", ext(2))).toBe("unversioned");
    expect(comparePiExtension(ext(1), ext(2))).toBe("stale");
    expect(comparePiExtension(ext(2), ext(2))).toBe("current");
    expect(comparePiExtension(ext(2, "edited"), ext(2))).toBe("differs");
    expect(comparePiExtension(ext(3), ext(2))).toBe("newer");
    expect(comparePiExtension(ext(2), undefined)).toBe("no-bundled");
  });

  it("maps the comparison to a check", () => {
    const facts = { dir: "/e", installedPath: "/e/harbormaster-inbox.ts" };
    expect(piExtensionCheck(facts, false).status).toBe("skip");
    expect(piExtensionCheck(facts, true).status).toBe("warn");
    expect(
      piExtensionCheck(
        { ...facts, installedText: ext(1), bundledText: ext(2) },
        true,
      ),
    ).toMatchObject({
      status: "warn",
      summary: "Pi extension is stale (v1 installed, v2 bundled)",
    });
    expect(
      piExtensionCheck(
        { ...facts, installedText: ext(2), bundledText: ext(2) },
        true,
      ).status,
    ).toBe("ok");
    expect(
      piExtensionCheck({ ...facts, installedText: ext(2) }, true).status,
    ).toBe("ok");
  });
});

describe("state checks", () => {
  it("state files: a count, or failed with the reason", () => {
    expect(
      stateFileCheck("state.tasks", "tasks.json", "task", { count: 1 }),
    ).toMatchObject({ status: "ok", summary: "1 task" });
    expect(
      stateFileCheck("state.tasks", "tasks.json", "task", {
        error: "Invalid tasks.json: bad state",
      }),
    ).toMatchObject({
      status: "fail",
      summary: "tasks.json was rejected",
      detail: "Invalid tasks.json: bad state",
    });
  });

  it("rules: problems warn (without repeating the file name); counts otherwise", () => {
    const file = (problems: string[], rules = 0): RuleFile =>
      ({
        file: "rules.yaml",
        path: "/s/rules/rules.yaml",
        rules: Array.from({ length: rules }, () => ({})),
        problems,
      }) as unknown as RuleFile;
    expect(rulesCheck({ files: [file([], 2)] })).toMatchObject({
      status: "ok",
      summary: "2 rules in 1 file",
    });
    const broken = rulesCheck({
      files: [file(["rules.yaml: bad"]), file(["line 3: worse"])],
    });
    expect(broken.status).toBe("warn");
    expect(broken.detail).toBe("rules.yaml: bad\nrules.yaml: line 3: worse");
    expect(rulesCheck({ error: "EACCES" }).status).toBe("fail");
  });
});

describe("repository checks", () => {
  it("codeRoot: missing, absent, not a folder, case and symlink spellings", () => {
    expect(codeRootCheck(undefined, undefined).status).toBe("warn");
    expect(
      codeRootCheck("/u/Code", { exists: false, isDirectory: false }).status,
    ).toBe("fail");
    expect(
      codeRootCheck("/u/Code", { exists: true, isDirectory: false }).status,
    ).toBe("fail");
    expect(
      codeRootCheck("/u/code", {
        exists: true,
        isDirectory: true,
        realPath: "/u/Code",
      }),
    ).toMatchObject({
      status: "warn",
      summary: "/u/code is spelled /u/Code on disk (case differs)",
    });
    expect(
      codeRootCheck("/u/src", {
        exists: true,
        isDirectory: true,
        realPath: "/Volumes/dev/src",
      }).summary,
    ).toBe("/u/src is a symlink to /Volumes/dev/src");
    expect(
      codeRootCheck("/u/Code", {
        exists: true,
        isDirectory: true,
        realPath: "/u/Code",
      }).status,
    ).toBe("ok");
  });

  it("discovered: warn on none", () => {
    expect(discoveredCheck(0, "/u/Code").status).toBe("warn");
    expect(discoveredCheck(3, "/u/Code").summary).toBe("3 repositories");
  });

  it("remote: one item per repository, the worst status wins", () => {
    expect(remoteCheck([]).status).toBe("skip");
    const good = {
      id: "github.com/a/ok",
      root: "/c/ok",
      probe: { ok: true, timedOut: false, ms: 412 },
    };
    expect(remoteCheck([good])).toMatchObject({
      status: "ok",
      summary: "1 remote reachable",
      items: [
        {
          name: "github.com/a/ok",
          status: "ok",
          summary: "reachable",
          ms: 412,
        },
      ],
    });
    const slow = {
      id: "github.com/a/slow",
      root: "/c/slow",
      probe: { ok: false, timedOut: true, ms: 20_000 },
    };
    const warned = remoteCheck([good, slow]);
    expect(warned).toMatchObject({
      status: "warn",
      summary: "1 did not answer within 20 s (of 2 probed)",
    });
    expect(warned.remediation).toContain("~100k refs");
    expect(warned.remediation).toContain("not of Harbormaster");
    const check = remoteCheck(
      [
        good,
        {
          id: "github.com/a/gone",
          root: "/c/gone",
          probe: {
            ok: false,
            timedOut: false,
            exitCode: 128,
            error: "ERROR: Repository not found.",
          },
        },
        slow,
      ],
      {
        notProbed: [
          { id: "github.com/a/idle", reason: "not probed (no active task)" },
        ],
      },
    );
    expect(check).toMatchObject({
      status: "fail",
      summary:
        "1 unreachable, 1 did not answer within 20 s (of 3 probed); 1 not probed",
    });
    expect(check.items?.map((item) => item.status)).toEqual([
      "ok",
      "fail",
      "warn",
    ]);
    expect(check.detail).toContain(
      "github.com/a/idle: not probed (no active task)",
    );
    expect(check.detail).toContain("--all-remotes");
    expect(check.remediation).toContain("git -C /c/gone ls-remote origin HEAD");
  });

  it("remote: nothing probed is skip with the reason", () => {
    expect(
      remoteCheck([], {
        notProbed: [{ id: "x", reason: "not probed (no active task)" }],
        skipReason: "Not probed: no repository has a task (active or recent)",
      }),
    ).toMatchObject({
      status: "skip",
      summary: "Not probed: no repository has a task (active or recent)",
    });
    expect(
      remoteCheck([
        {
          id: "github.com/a/x",
          root: "/x",
          skipped: "api.github.com unreachable",
        },
      ]),
    ).toMatchObject({
      status: "skip",
      summary: "Not probed: api.github.com unreachable",
      items: [
        { status: "skip", summary: "not probed (api.github.com unreachable)" },
      ],
    });
  });
});

describe("classifyRemoteProbe", () => {
  const failing = (error: string, exitCode = 128): RemoteProbe => ({
    ok: false,
    timedOut: false,
    exitCode,
    error,
  });

  it("ok when it answered (exit 0, or 2: no HEAD advertised)", () => {
    expect(classifyRemoteProbe({ ok: true, timedOut: false }).status).toBe(
      "ok",
    );
    expect(classifyRemoteProbe(failing("", 2))).toEqual({
      status: "ok",
      summary: "reachable (no HEAD advertised)",
    });
  });

  it("fail only for a definite error on exit 128", () => {
    for (const error of [
      "ERROR: Repository not found. — fatal: Could not read from remote repository.",
      "remote: Repository not found. — fatal: repository 'https://github.com/a/b/' not found",
      "git@github.com: Permission denied (publickey).",
      "fatal: Authentication failed for 'https://github.com/a/b/'",
      "fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com",
      "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known",
      "fatal: transport 'https' not allowed",
    ]) {
      expect(classifyRemoteProbe(failing(error))).toEqual({
        status: "fail",
        summary: error,
      });
    }
    // The same words on another exit code are not definite.
    expect(classifyRemoteProbe(failing("Permission denied", 1)).status).toBe(
      "warn",
    );
  });

  it("warn for a timeout or anything unclassified", () => {
    expect(classifyRemoteProbe({ ok: false, timedOut: true })).toEqual({
      status: "warn",
      summary: "did not answer within 20 s",
    });
    expect(
      classifyRemoteProbe(
        failing("fatal: unable to access 'https://x/': Operation timed out"),
      ),
    ).toMatchObject({ status: "warn" });
    expect(REMOTE_TIMEOUT_REMEDIATION).toMatch(
      /^the remote did not answer within 20 s/,
    );
  });
});

describe("selectRemoteProbes", () => {
  const repos = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }));
  const task = (
    repositoryId: string | undefined,
    state: string,
    updatedAt: string,
  ) => ({ repositoryId, state, updatedAt });

  it("active-task repositories, newest task first, capped at 5", () => {
    const scope = selectRemoteProbes(repos, [
      task("a", "working", "2026-01-01T00:00:01Z"),
      task("b", "awaiting", "2026-01-01T00:00:07Z"),
      task("c", "working", "2026-01-01T00:00:03Z"),
      task("b", "working", "2026-01-01T00:00:02Z"),
      task("d", "working", "2026-01-01T00:00:04Z"),
      task("e", "awaiting", "2026-01-01T00:00:05Z"),
      task("f", "working", "2026-01-01T00:00:06Z"),
      task("g", "done", "2026-01-01T00:00:09Z"),
      task("zz", "working", "2026-01-01T00:00:09Z"),
    ]);
    expect(scope.probe.map((repo) => repo.id)).toEqual([
      "b",
      "f",
      "e",
      "d",
      "c",
    ]);
    expect(scope.notProbed).toEqual([
      {
        id: "a",
        reason: "not probed (more than 5 repositories with active tasks)",
      },
      { id: "g", reason: "not probed (no active task)" },
    ]);
    expect(scope.skipReason).toBeUndefined();
  });

  it("falls back to the most recently updated task's repository", () => {
    const scope = selectRemoteProbes(repos, [
      task("c", "done", "2026-01-01T00:00:01Z"),
      task("d", "backlog", "2026-01-01T00:00:05Z"),
      task(undefined, "working", "2026-01-01T00:00:09Z"),
    ]);
    expect(scope.probe.map((repo) => repo.id)).toEqual(["d"]);
    expect(scope.notProbed).toHaveLength(6);
  });

  it("no task on a known repository: nothing probed, with the reason", () => {
    const scope = selectRemoteProbes(repos, []);
    expect(scope.probe).toEqual([]);
    expect(scope.notProbed).toHaveLength(7);
    expect(scope.skipReason).toBe(
      "Not probed: no repository has a task (active or recent)",
    );
  });

  it("all: every repository, no cap", () => {
    expect(selectRemoteProbes(repos, [], { all: true }).probe).toHaveLength(7);
  });
});

describe("thresholds", () => {
  it("disk: fail under 1 GiB, warn under 5 GiB", () => {
    expect(diskCheck(DISK_FAIL_BYTES - 1, "/s").status).toBe("fail");
    expect(diskCheck(DISK_FAIL_BYTES, "/s").status).toBe("warn");
    expect(diskCheck(DISK_WARN_BYTES - 1, "/s").status).toBe("warn");
    expect(diskCheck(DISK_WARN_BYTES, "/s").status).toBe("ok");
  });

  it("orphans: warn only once the scan's warning is set", () => {
    expect(orphansCheck({ root: "/w", orphans: [] }).summary).toBe(
      "No orphan worktrees",
    );
    expect(
      orphansCheck({ root: "/w", orphans: [{ path: "/w/a" }] }).status,
    ).toBe("ok");
    expect(
      orphansCheck({
        root: "/w",
        orphans: [{ path: "/w/a" }],
        warning: "12 worktrees",
      }).status,
    ).toBe("warn");
  });

  it("socket: ok when it answers, warn otherwise", () => {
    expect(
      socketCheck({ path: "/s", exists: true, responds: true }).status,
    ).toBe("ok");
    expect(
      socketCheck({ path: "/s", exists: false, responds: false }).summary,
    ).toBe("Harbormaster app is not running");
    expect(
      socketCheck({ path: "/s", exists: true, responds: false }).status,
    ).toBe("warn");
  });

  it("login-shell PATH: lists what the process PATH lacks", () => {
    expect(missingPathEntries("/a:/b:/c:/b", "/b:/x")).toEqual(["/a", "/c"]);
    expect(loginShellPathCheck(undefined, "/a").status).toBe("skip");
    expect(loginShellPathCheck("/a:/b", "/b:/a").status).toBe("ok");
    expect(loginShellPathCheck("/a:/b", "/b")).toMatchObject({
      status: "warn",
      detail: "/a",
    });
  });
});

describe("report rendering", () => {
  const report: DoctorReport = {
    checkedAt: "2026-01-01T00:00:00.000Z",
    appVersion: "0.2.4",
    checks: orderDoctorChecks([
      diskCheck(DISK_WARN_BYTES * 2, "/s"),
      commandCheck({
        id: "agents.pi",
        label: "Pi",
        command: "pi",
        resolved: "/b/pi",
        outcome: ok("1.3.0"),
        whenMissing: "fail",
        install: "-",
      }),
      commandCheck({
        id: "agents.claude",
        label: "Claude Code",
        command: "claude",
        outcome: notFound,
        whenMissing: "warn",
        install: "Install Claude Code.",
      }),
      githubAuthCheck(failed(), true),
    ]),
  };

  it("orders by group and renders ✓ ! ✗ - with indented remediation", () => {
    expect(report.checks.map((check) => check.id)).toEqual([
      "tools.gh-auth",
      "agents.pi",
      "agents.claude",
      "disk.free",
    ]);
    expect(formatDoctorReport(report)).toBe(
      [
        "Tools",
        "  ✗ tools.gh-auth  gh is not logged in",
        "      → Run `gh auth login` in a terminal.",
        "",
        "Agents",
        "  ✓ agents.pi  Pi 1.3.0",
        "  ! agents.claude  Claude Code is not on PATH",
        "      Looked for `claude`.",
        "      → Install Claude Code.",
        "",
        "Disk",
        "  ✓ disk.free  10.0 GiB free",
        "",
        "2 ok, 1 warning, 1 failed, 0 skipped",
      ].join("\n"),
    );
    expect(doctorExitCode(report)).toBe(1);
    expect(doctorExitCode({ checks: report.checks.slice(1) })).toBe(0);
  });

  it("renders per-repository lines under repos.remote", () => {
    const remote = remoteCheck([
      {
        id: "github.com/a/ok",
        root: "/c/ok",
        probe: { ok: true, timedOut: false, ms: 412 },
      },
    ]);
    expect(formatDoctorReport({ checkedAt: "", checks: [remote] })).toBe(
      [
        "Repositories",
        "  ✓ repos.remote  1 remote reachable",
        "      ✓ github.com/a/ok  reachable (412 ms)",
        "",
        "1 ok, 0 warnings, 0 failed, 0 skipped",
      ].join("\n"),
    );
  });

  it("plain summary: versions plus failing and warning checks", () => {
    expect(doctorPlainSummary(report, { os: "macOS 15.3" })).toBe(
      [
        "Harbormaster 0.2.4 on macOS 15.3",
        "pi: 1.3.0",
        "claude: Claude Code is not on PATH",
        "doctor:",
        "  ✗ tools.gh-auth: gh is not logged in",
        "  ! agents.claude: Claude Code is not on PATH",
      ].join("\n"),
    );
  });
});

// --- The command, end to end ------------------------------------------------

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs = [];
});

async function tempDir(): Promise<string> {
  // Real path: macOS's /var/folders is a symlink, which repos.codeRoot flags.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "hm-doctor-")));
  dirs.push(dir);
  return dir;
}

/** Fake probes on top of the real file-backed ones (state dir, paths, disk). */
function fakeProbes(
  stateDir: string,
  overrides: Partial<EnvironmentProbeAccess> = {},
): EnvironmentProbeAccess {
  const real = new LocalEnvironmentProbeAccess({
    paths: resolveStatePaths(stateDir),
    env: {
      PATH: "/usr/bin",
      HARBORMASTER_PI_EXTENSIONS_DIR: join(stateDir, "ext"),
    },
  });
  return Object.assign(Object.create(real) as EnvironmentProbeAccess, {
    resolveCommand: async (command: string) => `/bin/${command}`,
    commandVersion: async (command: string) => ok(`${command} 1.0.0`),
    githubAuthStatus: async () => ok(),
    remoteReachable: async () => ({ ok: true, timedOut: false }),
    ...overrides,
  });
}

describe("doctor command", () => {
  it("never writes: a missing config is reported, not created", async () => {
    const stateDir = join(await tempDir(), "state");
    const core = createCore({ stateDir, environment: fakeProbes(stateDir) });
    const report = await core.commands.doctor({ loginShellPath: "/usr/bin" });
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get("state.config")?.status).toBe("warn");
    expect(byId.get("repos.codeRoot")?.status).toBe("skip");
    expect(byId.get("agents.pi")?.status).toBe("ok");
    expect(byId.get("path.loginShell")?.status).toBe("ok");
    expect(byId.get("socket.tool")?.status).toBe("warn");
    await expect(readdir(stateDir)).rejects.toThrow();
  });

  it("checks a configured state dir and surfaces a rejected state file", async () => {
    const root = await tempDir();
    const stateDir = join(root, "state");
    const codeRoot = join(root, "Code");
    await mkdir(join(stateDir, "rules"), { recursive: true });
    await mkdir(codeRoot);
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({ codeRoot, branchPrefix: "" }),
    );
    await writeFile(join(stateDir, "tasks.json"), "{ not json");
    await writeFile(join(stateDir, "rules", "rules.yaml"), "rules: [oops");
    const before = (await readdir(stateDir)).sort();
    const core = createCore({
      stateDir,
      environment: fakeProbes(stateDir, {
        resolveCommand: async (command) =>
          command === "claude" ? undefined : `/bin/${command}`,
        commandVersion: async (command) =>
          command === "claude" ? notFound : ok(`${command} 2.0.0`),
      }),
    });
    const report = await core.commands.doctor({ appVersion: "9.9.9" });
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(report.appVersion).toBe("9.9.9");
    expect(byId.get("state.tasks")).toMatchObject({ status: "fail" });
    expect(byId.get("state.bindings")).toMatchObject({ status: "ok" });
    expect(byId.get("state.rules")?.status).toBe("warn");
    expect(byId.get("state.config")?.status).toBe("ok");
    expect(byId.get("repos.codeRoot")?.status).toBe("ok");
    expect(byId.get("repos.discovered")?.status).toBe("warn");
    expect(byId.get("repos.remote")?.status).toBe("skip");
    expect(byId.get("agents.claude")?.status).toBe("warn");
    expect(byId.get("agents.pi-extension")?.status).toBe("warn");
    expect(byId.get("worktrees.orphans")?.status).toBe("ok");
    expect(byId.get("path.loginShell")?.status).toBe("skip");
    // Read-only: no managed rules guide, no default files, nothing new.
    expect((await readdir(stateDir)).sort()).toEqual(before);
    expect(await readdir(join(stateDir, "rules"))).toEqual(["rules.yaml"]);
  });

  it("a probe that throws or hangs becomes skip, never a rejection", async () => {
    const stateDir = join(await tempDir(), "state");
    const core = createCore({
      stateDir,
      environment: fakeProbes(stateDir, {
        githubAuthStatus: async () => {
          throw new Error("kaboom");
        },
        stateDirFreeBytes: () => new Promise(() => {}),
      }),
    });
    const report = await core.commands.doctor();
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get("tools.gh-auth")).toMatchObject({
      status: "skip",
      summary: "Could not check: kaboom",
    });
    expect(byId.get("disk.free")).toMatchObject({
      status: "skip",
      summary: "Timed out after 6 s",
    });
  }, 15_000);
});

describe("probe timeouts per kind", () => {
  afterEach(() => setProcessRunner(undefined));

  it("local probes get LOCAL_PROBE_TIMEOUT_MS, network probes NETWORK_PROBE_TIMEOUT_MS", async () => {
    expect(LOCAL_PROBE_TIMEOUT_MS).toBe(5_000);
    expect(NETWORK_PROBE_TIMEOUT_MS).toBe(20_000);
    expect(NETWORK_PROBE_CONCURRENCY).toBe(5);
    const seen: ProcessRunRequest[] = [];
    setProcessRunner(async (request) => {
      seen.push(request);
      if (request.args.includes("ls-remote")) {
        throw Object.assign(new Error("exit 128"), {
          code: 128,
          stdout: "",
          stderr:
            "ERROR: Repository not found.\nfatal: Could not read from remote repository.\n",
        });
      }
      return { stdout: "x 1.0.0", stderr: "" };
    });
    const probes = new LocalEnvironmentProbeAccess({
      paths: resolveStatePaths("/nonexistent-state"),
      env: { PATH: "/usr/bin" },
    });
    await probes.commandVersion("git");
    await probes.githubAuthStatus();
    const remote = await probes.remoteReachable("/c/repo");
    const timeoutOf = (match: (request: ProcessRunRequest) => boolean) =>
      seen.find(match)?.timeoutMs;
    expect(timeoutOf((r) => r.args[0] === "--version")).toBe(
      LOCAL_PROBE_TIMEOUT_MS,
    );
    expect(timeoutOf((r) => r.args.join(" ") === "auth status")).toBe(
      NETWORK_PROBE_TIMEOUT_MS,
    );
    expect(timeoutOf((r) => r.args.includes("ls-remote"))).toBe(
      NETWORK_PROBE_TIMEOUT_MS,
    );
    expect(remote).toMatchObject({
      ok: false,
      timedOut: false,
      exitCode: 128,
      error:
        "ERROR: Repository not found. — fatal: Could not read from remote repository.",
    });
    expect(typeof remote.ms).toBe("number");
    expect(classifyRemoteProbe(remote).status).toBe("fail");
  });
});

describe("doctor runtime: repos.remote scope and network probes", () => {
  const repo = (name: string, host = "github.com") => ({
    id: `${host}/acme/${name}`,
    root: `/c/${name}`,
    defaultBranch: "main",
    remoteUrl: `https://${host}/acme/${name}.git`,
    checkouts: [],
  });
  const task = (repositoryId: string, state: string, updatedAt: string) => ({
    id: `t-${repositoryId}-${updatedAt}`,
    repositoryId,
    state,
    updatedAt,
  });

  function runtime(options: {
    repositories: ReturnType<typeof repo>[];
    tasks?: Array<ReturnType<typeof task>>;
    probes?: Partial<EnvironmentProbeAccess>;
  }): DoctorRuntime {
    const probes = {
      processPath: () => "/usr/bin",
      platform: () => "darwin",
      commands: () => ({ git: "git", gh: "gh", pi: "pi", claude: "claude" }),
      resolveCommand: async (command: string) => `/bin/${command}`,
      commandVersion: async (command: string) => ok(`${command} 1.0.0`),
      githubAuthStatus: async () => ok(),
      piExtension: async () => ({ dir: "/e", installedPath: "/e/x.ts" }),
      pathFacts: async () => ({
        exists: true,
        isDirectory: true,
        realPath: "/c",
      }),
      configFile: async () => ({ path: "/s/config.json", exists: true }),
      stateDirFreeBytes: async () => ({
        path: "/s",
        freeBytes: 100 * 1024 ** 3,
      }),
      remoteReachable: async (): Promise<RemoteProbe> => ({
        ok: true,
        timedOut: false,
        ms: 5,
      }),
      toolSocket: async () => ({
        path: "/s/sock",
        exists: false,
        responds: false,
      }),
      ...options.probes,
    } as EnvironmentProbeAccess;
    return new DoctorRuntime({
      probes,
      config: { load: async () => ({ codeRoot: "/c" }) } as never,
      tasks: { listTasks: async () => options.tasks ?? [] } as never,
      bindings: { listBindings: async () => [] } as never,
      now: () => new Date("2026-01-01T00:00:00Z"),
      repositories: async () => options.repositories,
      orphans: async () => ({ root: "/w", orphans: [] }),
    });
  }

  const byId = (report: DoctorReport) =>
    new Map(report.checks.map((check) => [check.id, check]));

  it("probes only repositories with an active task; every check carries ms", async () => {
    const probed: string[] = [];
    const report = await runtime({
      repositories: [repo("alpha"), repo("beta"), repo("gamma")],
      tasks: [
        task("github.com/acme/beta", "working", "2026-01-01T00:00:02Z"),
        task("github.com/acme/gamma", "done", "2026-01-01T00:00:09Z"),
      ],
      probes: {
        remoteReachable: async (root) => {
          probed.push(root);
          return { ok: true, timedOut: false, ms: 7 };
        },
      },
    }).run();
    expect(probed).toEqual(["/c/beta"]);
    const remote = byId(report).get("repos.remote");
    expect(remote).toMatchObject({
      status: "ok",
      summary: "1 remote reachable; 2 not probed",
      items: [{ name: "github.com/acme/beta", status: "ok", ms: 7 }],
    });
    expect(remote?.detail).toContain(
      "github.com/acme/alpha: not probed (no active task)",
    );
    for (const check of report.checks) {
      expect(typeof check.ms, check.id).toBe("number");
    }
    expect(byId(report).get("tools.gh-auth")?.summary).toMatch(
      /^gh is logged in \(api\.github\.com reachable, \d+ ms\)$/,
    );
  });

  it("probeAllRemotes probes every repository, at most 5 at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probed: string[] = [];
    const repositories = Array.from({ length: 12 }, (_, index) =>
      repo(`r${String(index).padStart(2, "0")}`),
    );
    const report = await runtime({
      repositories,
      probes: {
        remoteReachable: async (root) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight--;
          probed.push(root);
          return { ok: true, timedOut: false, ms: 10 };
        },
      },
    }).run({ probeAllRemotes: true });
    expect(probed).toHaveLength(12);
    expect(maxInFlight).toBe(NETWORK_PROBE_CONCURRENCY);
    expect(byId(report).get("repos.remote")).toMatchObject({
      status: "ok",
      summary: "12 remotes reachable",
    });
  });

  it("no task at all: nothing probed, skip with the reason", async () => {
    let calls = 0;
    const report = await runtime({
      repositories: [repo("alpha")],
      probes: {
        remoteReachable: async () => {
          calls++;
          return { ok: true, timedOut: false };
        },
      },
    }).run();
    expect(calls).toBe(0);
    expect(byId(report).get("repos.remote")).toMatchObject({
      status: "skip",
      summary: "Not probed: no repository has a task (active or recent)",
    });
  });

  it("api.github.com unreachable: github.com remotes are skipped with that reason", async () => {
    const probed: string[] = [];
    const report = await runtime({
      repositories: [repo("alpha"), repo("own", "git.example.com")],
      tasks: [
        task("github.com/acme/alpha", "working", "2026-01-01T00:00:01Z"),
        task("git.example.com/acme/own", "awaiting", "2026-01-01T00:00:02Z"),
      ],
      probes: {
        githubAuthStatus: async () => timedOut,
        remoteReachable: async (root) => {
          probed.push(root);
          return { ok: true, timedOut: false };
        },
      },
    }).run();
    expect(probed).toEqual(["/c/own"]);
    expect(byId(report).get("tools.gh-auth")?.status).toBe("warn");
    expect(byId(report).get("repos.remote")?.items).toEqual([
      expect.objectContaining({
        name: "git.example.com/acme/own",
        status: "ok",
      }),
      {
        name: "github.com/acme/alpha",
        status: "skip",
        summary: "not probed (api.github.com unreachable)",
      },
    ]);
  });

  it("a timeout is warn, a definite error fail: the check takes the worst", async () => {
    const report = await runtime({
      repositories: [repo("slow"), repo("gone")],
      tasks: [
        task("github.com/acme/slow", "working", "2026-01-01T00:00:01Z"),
        task("github.com/acme/gone", "working", "2026-01-01T00:00:02Z"),
      ],
      probes: {
        remoteReachable: async (root) =>
          root === "/c/slow"
            ? { ok: false, timedOut: true, ms: 20_000 }
            : {
                ok: false,
                timedOut: false,
                exitCode: 128,
                error: "remote: Repository not found.",
              },
      },
    }).run();
    const remote = byId(report).get("repos.remote");
    expect(remote?.status).toBe("fail");
    expect(remote?.items?.map((item) => [item.name, item.status])).toEqual([
      ["github.com/acme/gone", "fail"],
      ["github.com/acme/slow", "warn"],
    ]);
  });
});

describe("repos.version-endpoints", () => {
  const stage = (id: string, url: unknown, hook = "version-endpoint") => ({
    id,
    label: id,
    hook,
    options: { url },
  });
  const config = {
    repositories: {
      "github.com/acme/api": {
        deployment: {
          stages: [
            stage("staging", "https://bob:pw@staging.example/version?k=1"),
            stage("prod", "https://prod.example/version"),
            stage("manual", "https://ignored.example/v", "none"),
            stage("plain-http", "http://insecure.example/v"),
          ],
        },
      },
      "github.com/acme/web": {
        deployment: { stages: [stage("prod", "https://prod.example/version")] },
      },
    },
  };

  it("targets each distinct https URL of a version-endpoint stage once", () => {
    expect(versionEndpointTargets(config)).toEqual([
      {
        url: "https://bob:pw@staging.example/version?k=1",
        stages: ["github.com/acme/api staging"],
      },
      {
        url: "https://prod.example/version",
        stages: ["github.com/acme/api prod", "github.com/acme/web prod"],
      },
    ]);
  });

  it("fails an untrusted certificate with the trust remediation, never leaking credentials", () => {
    const [staging, prod] = versionEndpointTargets(config);
    if (!staging || !prod) throw new Error("targets");
    const result = versionEndpointCheck([
      {
        target: staging,
        error: `GET ${staging.url} failed: fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self signed certificate in certificate chain)`,
      },
      { target: prod, ms: 12 },
    ]);
    expect(result).toMatchObject({
      id: "repos.version-endpoints",
      group: "repos",
      status: "fail",
      summary:
        "1 of 2 version endpoints failed (1 with an untrusted TLS certificate)",
      items: [
        {
          name: "github.com/acme/api staging (https://staging.example/version)",
          status: "fail",
          summary: "TLS certificate not trusted",
        },
        { status: "ok", summary: "reachable", ms: 12 },
      ],
    });
    expect(result.remediation).toContain("NODE_EXTRA_CA_CERTS");
    expect(JSON.stringify(result)).not.toContain("pw@");
  });

  it("warns when offline, fails any other error, skips without stages", () => {
    const [staging, prod] = versionEndpointTargets(config);
    if (!staging || !prod) throw new Error("targets");
    expect(
      versionEndpointCheck([
        {
          target: prod,
          error: `GET ${prod.url} failed: net::ERR_INTERNET_DISCONNECTED`,
        },
      ]).status,
    ).toBe("warn");
    const notFound = versionEndpointCheck([
      { target: staging, error: `GET ${staging.url} failed: HTTP 404` },
    ]);
    expect(notFound.status).toBe("fail");
    expect(notFound.items?.[0]?.summary).toBe(
      "GET https://staging.example/version failed: HTTP 404",
    );
    expect(versionEndpointCheck([]).status).toBe("skip");
  });

  it("the doctor command fetches each URL through core's version access", async () => {
    const stateDir = join(await tempDir(), "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "config.json"), JSON.stringify(config));
    const fetched: string[] = [];
    const core = createCore({
      stateDir,
      environment: fakeProbes(stateDir),
      versions: {
        fetchText: async (url: string) => {
          fetched.push(url);
          if (url.includes("staging")) {
            throw new Error(
              `GET ${url} failed: net::ERR_CERT_AUTHORITY_INVALID`,
            );
          }
          return "v1.0.0+abc";
        },
      },
    });
    const report = await core.commands.doctor();
    expect(fetched.sort()).toEqual([
      "https://bob:pw@staging.example/version?k=1",
      "https://prod.example/version",
    ]);
    const check = report.checks.find(
      (item) => item.id === "repos.version-endpoints",
    );
    expect(check).toMatchObject({
      status: "fail",
      items: [
        { status: "fail", summary: "TLS certificate not trusted" },
        { status: "ok" },
      ],
    });
  });
});
