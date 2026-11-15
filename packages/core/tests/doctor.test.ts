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
import type {
  DoctorReport,
  EnvironmentProbeAccess,
} from "../src/contracts/doctor.js";
import type { ProbeOutcome } from "../src/contracts/onboarding.js";
import type { RuleFile } from "../src/contracts/rules.js";
import {
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
  loginShellPathCheck,
  missingPathEntries,
  orderDoctorChecks,
  orphansCheck,
  piExtensionCheck,
  remoteCheck,
  rulesCheck,
  socketCheck,
  stateFileCheck,
} from "../src/engines/doctor.js";
import { createCore } from "../src/index.js";
import {
  comparePiExtension,
  resolvePiExtensionsDir,
} from "../src/utilities/pi-extension.js";
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

describe("githubAuthCheck (exit code only)", () => {
  it("maps the exit code, whatever gh printed", () => {
    expect(githubAuthCheck(ok("anything"), true).status).toBe("ok");
    expect(
      githubAuthCheck(failed("Logged in to github.com account x"), true),
    ).toMatchObject({ status: "fail", summary: "gh is not logged in" });
    expect(githubAuthCheck(failed(), false).status).toBe("warn");
    expect(githubAuthCheck(notFound, true).status).toBe("skip");
    expect(githubAuthCheck(timedOut, true).status).toBe("skip");
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

  it("remote: fail lists the unreachable repositories", () => {
    expect(remoteCheck([]).status).toBe("skip");
    const good = {
      id: "github.com/a/ok",
      root: "/c/ok",
      probe: { ok: true, timedOut: false },
    };
    expect(remoteCheck([good]).status).toBe("ok");
    const check = remoteCheck([
      good,
      {
        id: "github.com/a/gone",
        root: "/c/gone",
        probe: { ok: false, timedOut: false, error: "Repository not found." },
      },
      {
        id: "github.com/a/slow",
        root: "/c/slow",
        probe: { ok: false, timedOut: true },
      },
    ]);
    expect(check).toMatchObject({
      status: "fail",
      summary: "2 of 3 remotes unreachable",
    });
    expect(check.detail).toBe(
      "github.com/a/gone: Repository not found.\ngithub.com/a/slow: timed out after 3 s",
    );
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
      summary: "Timed out after 4 s",
    });
  }, 15_000);
});
