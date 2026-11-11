// The first-run wizard's pure rules (engines/onboarding.ts), the config
// writes behind it (JsonConfigAccess.applySettings) and the onboarding
// commands end to end on a temp state dir with fake machine probes.

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { JsonConfigAccess } from "../src/access/json-config-access.js";
import { LocalOnboardingProbeAccess } from "../src/access/local-onboarding-probe-access.js";
import type {
  OnboardingProbeAccess,
  ProbeOutcome,
} from "../src/contracts/onboarding.js";
import type { RepositoryInfo } from "../src/contracts/workspace.js";
import {
  customAgentProblems,
  expandHome,
  parseCliVersion,
  parseGhAuthStatus,
  protectedHomeFolder,
  toScannedRepositories,
} from "../src/engines/onboarding.js";
import { createCore } from "../src/index.js";

const execFileAsync = promisify(execFile);
const HOME = "/Users/alice";

describe("protectedHomeFolder", () => {
  it("flags ~/Documents, ~/Desktop, ~/Downloads and anything inside them", () => {
    expect(protectedHomeFolder("/Users/alice/Documents", HOME)).toBe(
      "Documents",
    );
    expect(protectedHomeFolder("/Users/alice/Documents/code", HOME)).toBe(
      "Documents",
    );
    expect(protectedHomeFolder("~/Desktop/x", HOME)).toBe("Desktop");
    expect(protectedHomeFolder("/Users/alice/Downloads/", HOME)).toBe(
      "Downloads",
    );
    // Case-insensitive like the default macOS volume.
    expect(protectedHomeFolder("/Users/alice/documents/repo", HOME)).toBe(
      "Documents",
    );
  });

  it("leaves plain folders and look-alikes alone", () => {
    expect(protectedHomeFolder("/Users/alice/Code", HOME)).toBeUndefined();
    expect(
      protectedHomeFolder("/Users/alice/Documents-old", HOME),
    ).toBeUndefined();
    expect(protectedHomeFolder("/Users/bob/Documents", HOME)).toBeUndefined();
    expect(protectedHomeFolder("/Volumes/x/Documents", HOME)).toBeUndefined();
    expect(protectedHomeFolder("", HOME)).toBeUndefined();
  });

  it("expands ~ against the given home", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/Code/", HOME)).toBe("/Users/alice/Code");
    expect(expandHome(" /tmp/x ", HOME)).toBe("/tmp/x");
  });
});

describe("custom agent ids", () => {
  it("accepts a lowercase id that is not a built-in", () => {
    expect(
      customAgentProblems({ id: "aider", label: "Aider", command: "aider" }),
    ).toEqual([]);
    expect(
      customAgentProblems({
        id: "my_agent-2",
        label: "Mine",
        command: "/usr/local/bin/mine",
        args: ["--yes"],
      }),
    ).toEqual([]);
  });

  it("rejects built-in, malformed and empty ids, empty labels and relative command paths", () => {
    expect(
      customAgentProblems({ id: "pi", label: "P", command: "x" })[0],
    ).toMatch(/built-in/);
    expect(
      customAgentProblems({ id: "claude-code", label: "C", command: "x" })[0],
    ).toMatch(/built-in/);
    expect(
      customAgentProblems({ id: "My Agent", label: "M", command: "x" })[0],
    ).toMatch(/lowercase/);
    expect(
      customAgentProblems({ id: "", label: "M", command: "x" })[0],
    ).toMatch(/needs an id/);
    expect(customAgentProblems({ id: "a", label: " ", command: "x" })).toEqual([
      "The agent needs a label.",
    ]);
    expect(
      customAgentProblems({ id: "a", label: "A", command: "bin/a" })[0],
    ).toMatch(/absolute/);
  });
});

describe("probe output parsing", () => {
  it("finds the version token in --version output", () => {
    expect(parseCliVersion("2.1.322 (Claude Code)")).toBe("2.1.322");
    expect(parseCliVersion("pi v0.71.0\n")).toBe("0.71.0");
    expect(parseCliVersion("tool 1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseCliVersion("no version here")).toBeUndefined();
  });

  it("reads the active account from new and old gh auth status output", () => {
    const multi = [
      "github.com",
      "  ✓ Logged in to github.com account work-user (keyring)",
      "  - Active account: false",
      "  - Git operations protocol: https",
      "",
      "  ✓ Logged in to github.com account finete (keyring)",
      "  - Active account: true",
      "  - Token scopes: 'repo'",
    ].join("\n");
    expect(parseGhAuthStatus(multi)).toEqual({
      host: "github.com",
      account: "finete",
    });
    expect(
      parseGhAuthStatus(
        "github.com\n  ✓ Logged in to github.com as octocat (oauth_token)\n",
      ),
    ).toEqual({ host: "github.com", account: "octocat" });
    expect(
      parseGhAuthStatus(
        "You are not logged into any GitHub hosts. To log in, run: gh auth login",
      ),
    ).toBeUndefined();
  });

  it("maps a repository scan to one named row per identity, sorted", () => {
    const repo = (id: string, root: string): RepositoryInfo => ({
      id,
      root,
      defaultBranch: "main",
      checkouts: [{ root, isPrimary: true }],
    });
    expect(
      toScannedRepositories([
        repo("github.com/acme/web", "/code/web"),
        repo("github.com/acme/api", "/code/api"),
        repo("github.com/acme/api", "/code/api2"),
      ]),
    ).toEqual([
      { id: "github.com/acme/api", name: "api", root: "/code/api" },
      { id: "github.com/acme/web", name: "web", root: "/code/web" },
    ]);
  });
});

describe("JsonConfigAccess.applySettings", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("patches only the given keys and keeps everything else verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hbm-onboarding-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        automation: true,
        codeRoot: "/old",
        movers: ["legacy"],
        launch: { maxConcurrent: 3 },
        agents: {
          custom: [{ id: "aider", label: "Old", command: "aider" }],
        },
        sources: { github: { settings: { mentions: true } } },
      }),
    );
    const access = new JsonConfigAccess(path);
    const config = await access.applySettings({
      codeRoot: "/new",
      defaultHarness: "aider",
      bypassPermissions: false,
      customAgent: {
        id: "aider",
        label: "Aider",
        command: "aider",
        args: ["--yes"],
        promptArg: "positional",
      },
      sourceEnabled: { id: "github", enabled: false },
      onboardingCompletedAt: "2026-11-11T00:00:00.000Z",
    });
    expect(config.codeRoot).toBe("/new");
    expect(config.onboardingCompletedAt).toBe("2026-11-11T00:00:00.000Z");
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toEqual({
      automation: true,
      codeRoot: "/new",
      movers: ["legacy"],
      launch: {
        maxConcurrent: 3,
        defaultHarness: "aider",
        bypassPermissions: false,
      },
      agents: {
        custom: [
          {
            id: "aider",
            label: "Aider",
            command: "aider",
            args: ["--yes"],
            promptArg: "positional",
          },
        ],
      },
      sources: { github: { settings: { mentions: true }, enabled: false } },
      onboardingCompletedAt: "2026-11-11T00:00:00.000Z",
    });
    expect((await access.load()).onboardingCompletedAt).toBe(
      "2026-11-11T00:00:00.000Z",
    );
  });

  it("writes nothing when the patched config would be invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hbm-onboarding-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ codeRoot: "/old" }));
    const access = new JsonConfigAccess(path);
    await expect(
      access.applySettings({ codeRoot: "relative" }),
    ).rejects.toThrow(/codeRoot/);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      codeRoot: "/old",
    });
  });
});

describe("onboarding commands", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const outcome = (patch: Partial<ProbeOutcome>): ProbeOutcome => ({
    ok: false,
    output: "",
    notFound: false,
    timedOut: false,
    ...patch,
  });

  async function setup(probes: Partial<OnboardingProbeAccess> = {}) {
    const root = await mkdtemp(join(tmpdir(), "hbm-onboarding-"));
    dirs.push(root);
    const home = join(root, "home");
    await mkdir(join(home, "Documents", "code"), { recursive: true });
    const fake: OnboardingProbeAccess = {
      homeDir: () => home,
      isDirectory: (path) =>
        stat(path).then(
          (info) => info.isDirectory(),
          () => false,
        ),
      createDirectory: async (path) => {
        await mkdir(path, { recursive: true });
      },
      builtinAgentCommands: () => [
        { id: "pi", label: "Pi", command: "pi" },
        { id: "claude-code", label: "Claude Code", command: "claude" },
      ],
      resolveCommand: async (command) =>
        command === "claude" ? "/opt/bin/claude" : undefined,
      cliVersion: async (command) =>
        command === "claude"
          ? outcome({ ok: true, output: "2.1.322 (Claude Code)" })
          : outcome({ notFound: true }),
      githubAuthStatus: async () =>
        outcome({
          ok: true,
          output:
            "github.com\n  ✓ Logged in to github.com account finete (keyring)\n  - Active account: true",
        }),
      ...probes,
    };
    const core = createCore({
      stateDir: join(root, "state"),
      onboarding: fake,
    });
    return { root, home, stateDir: join(root, "state"), core };
  }

  it("scans a code root for git repositories and saves it", async () => {
    const { root, core, stateDir } = await setup();
    const codeRoot = join(root, "code");
    for (const name of ["web", "api"]) {
      await mkdir(join(codeRoot, name), { recursive: true });
      await execFileAsync("git", ["init", "-q", "-b", "main"], {
        cwd: join(codeRoot, name),
      });
    }
    await mkdir(join(codeRoot, "notes"));
    const scan = await core.commands.scanCodeRoot(codeRoot);
    expect(scan.exists).toBe(true);
    expect(scan.protectedFolder).toBeUndefined();
    expect(scan.repositories.map((repo) => repo.name)).toEqual(["api", "web"]);

    expect((await core.commands.getOnboardingState()).completedAt).toBe(
      undefined,
    );
    await core.commands.setCodeRoot(codeRoot);
    const raw = JSON.parse(
      await readFile(join(stateDir, "config.json"), "utf8"),
    );
    expect(raw.codeRoot).toBe(codeRoot);
    expect(
      (await core.commands.listRepositories()).map((repo) => repo.root).sort(),
    ).toHaveLength(2);
  });

  it("warns about a protected root, refuses a missing one, and creates ~/Code on request", async () => {
    const { home, core } = await setup();
    const scan = await core.commands.scanCodeRoot("~/Documents/code");
    expect(scan.root).toBe(join(home, "Documents", "code"));
    expect(scan.protectedFolder).toBe("Documents");
    expect(scan.suggestedRoot).toBe(join(home, "Code"));
    await expect(core.commands.setCodeRoot("~/Code")).rejects.toThrow(
      /not a folder/,
    );
    const created = await core.commands.setCodeRoot("~/Code", { create: true });
    expect(created).toMatchObject({ root: join(home, "Code"), exists: true });
    expect((await core.commands.getOnboardingState()).codeRoot).toBe(
      join(home, "Code"),
    );
  });

  it("detects agents with versions and saves the default agent", async () => {
    const { core } = await setup();
    expect(await core.commands.detectAgents()).toEqual([
      {
        id: "pi",
        label: "Pi",
        command: "pi",
        available: false,
        error: "not found",
      },
      {
        id: "claude-code",
        label: "Claude Code",
        command: "claude",
        path: "/opt/bin/claude",
        available: true,
        version: "2.1.322",
      },
    ]);
    const state = await core.commands.setDefaultAgent({
      harness: "claude-code",
      bypassPermissions: false,
    });
    expect(state).toMatchObject({
      defaultHarness: "claude-code",
      bypassPermissions: false,
    });
    expect((await core.commands.getLaunchSettings()).defaultHarness).toBe(
      "claude-code",
    );
  });

  it("adds a custom CLI agent as the default and rejects a built-in id", async () => {
    const { core } = await setup();
    await expect(
      core.commands.setDefaultAgent({
        harness: "pi",
        customAgent: { id: "pi", label: "Pi", command: "pi" },
      }),
    ).rejects.toThrow(/built-in/);
    await expect(
      core.commands.setDefaultAgent({ harness: "nope" }),
    ).rejects.toThrow(/Unknown agent/);
    const state = await core.commands.setDefaultAgent({
      harness: "aider",
      customAgent: {
        id: "aider",
        label: "Aider",
        command: "aider",
        args: ["--yes", ""],
        promptArg: "none",
      },
    });
    expect(state.defaultHarness).toBe("aider");
    expect(state.customAgents).toEqual([
      {
        id: "aider",
        label: "Aider",
        command: "aider",
        args: ["--yes"],
        promptArg: "none",
      },
    ]);
    const catalogs = await core.commands.listModels();
    expect(catalogs.map((catalog) => catalog.harness)).toContain("aider");
  });

  it("reports gh auth, toggles the github source, writes default rules, completes", async () => {
    const { core, stateDir } = await setup();
    expect(await core.commands.githubAuthStatus()).toEqual({
      installed: true,
      authenticated: true,
      account: "finete",
      host: "github.com",
    });
    expect((await core.commands.getOnboardingState()).githubEnabled).toBe(true);
    await core.commands.setSourceEnabled("github", false);
    expect((await core.commands.getOnboardingState()).githubEnabled).toBe(
      false,
    );
    expect(await core.commands.ensureDefaultRules()).toEqual({ created: true });
    expect(
      await readFile(join(stateDir, "rules", "rules.yaml"), "utf8"),
    ).toMatch(/rules:/);
    expect(await core.commands.ensureDefaultRules()).toEqual({
      created: false,
    });
    const done = await core.commands.completeOnboarding();
    expect(done.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("explains a missing or logged-out gh", async () => {
    const missing = await setup({
      githubAuthStatus: async () => outcome({ notFound: true }),
    });
    expect(await missing.core.commands.githubAuthStatus()).toMatchObject({
      installed: false,
      authenticated: false,
    });
    const loggedOut = await setup({
      githubAuthStatus: async () =>
        outcome({
          output:
            "You are not logged into any GitHub hosts. To log in, run: gh auth login",
        }),
    });
    expect(await loggedOut.core.commands.githubAuthStatus()).toEqual({
      installed: true,
      authenticated: false,
      error:
        "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    });
  });
});

describe("LocalOnboardingProbeAccess", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function script(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "hbm-probe-"));
    dirs.push(dir);
    const file = join(dir, "cli");
    await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  it("runs --version, reports a missing command, and times out a hung one", async () => {
    const claude = await script('echo "2.1.322 (Claude Code)"');
    const gh = await script(
      'echo "You are not logged into any GitHub hosts." >&2; exit 1',
    );
    const access = new LocalOnboardingProbeAccess({
      env: {
        HARBORMASTER_CLAUDE_COMMAND: claude,
        HARBORMASTER_PI_COMMAND: "/nonexistent/pi",
        HARBORMASTER_GH_COMMAND: gh,
      },
      timeoutMs: 5_000,
    });
    expect(access.builtinAgentCommands().map((agent) => agent.command)).toEqual(
      ["/nonexistent/pi", claude],
    );
    expect(await access.cliVersion(claude)).toMatchObject({
      ok: true,
      output: "2.1.322 (Claude Code)",
    });
    expect(await access.cliVersion("/nonexistent/pi")).toMatchObject({
      ok: false,
      notFound: true,
    });
    expect(await access.githubAuthStatus()).toMatchObject({
      ok: false,
      notFound: false,
      output: "You are not logged into any GitHub hosts.",
    });
    // PATH lookup for a bare name; a path is checked as is.
    const bin = dirname(claude);
    const onPath = new LocalOnboardingProbeAccess({
      env: { PATH: ["/nonexistent", bin].join(delimiter) },
    });
    expect(await onPath.resolveCommand("cli")).toBe(claude);
    expect(await onPath.resolveCommand(claude)).toBe(claude);
    expect(await onPath.resolveCommand("no-such-cli")).toBeUndefined();
    expect(await onPath.resolveCommand("/nonexistent/pi")).toBeUndefined();
    const impatient = new LocalOnboardingProbeAccess({ timeoutMs: 300 });
    expect(await impatient.cliVersion(await script("sleep 5"))).toMatchObject({
      ok: false,
      timedOut: true,
    });
  });
});
