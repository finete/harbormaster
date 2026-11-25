#!/usr/bin/env node
// Records REAL herdr state for the import reader's tests (docs/import.md
// "Fixtures and tests", F7): runs herdr's own headless servers against a
// TEMP `XDG_CONFIG_HOME` (never the user's `~/.config/herdr`), drives them
// through herdr's own CLI, and copies what herdr wrote into
//
//   packages/core/tests/fixtures/import/herdr/<version>/
//     cfg/herdr/session.json                  the default session's file
//     cfg/herdr/sessions/scratch/session.json a named session's file
//     session-list.json                       `herdr session list --json`, both running
//     session-list-scratch-stopped.json       the same after the named session stopped
//     api-snapshot-default.json               `herdr api snapshot` of the running default session
//     api-snapshot-scratch.json               ... of the named one (taken while it ran)
//     meta.json                               { version, recordedAt, agents }
//
// Absolute paths are rewritten to placeholders: `__ROOT__` (the temp root;
// `cfg/` lives under it) and `__HOME__`. Tests expand `__ROOT__` to a temp
// copy of `cfg/`, so the reader reads the files exactly as herdr wrote them.
//
// What it builds: a temp git repo with a linked worktree; in the default
// session a workspace "Billing rework" (custom name) on the worktree with a
// REAL Pi agent (three short prompts, so herdr records `agent_session`) and a
// second tab "tests" on the main checkout, plus an unnamed workspace on a
// plain folder, plus a workspace "Claude review" on a third worktree with a
// REAL Claude Code agent (three short prompts); in the named session
// `scratch` a workspace "Scratch notes" on a second worktree with a Pi agent.
//
// herdr records `agent_session` only through its agent integration, which
// writes into the user's real agent config. For Pi that is
// `~/.pi/agent/extensions/herdr-agent-state.ts`: the script installs it only
// when `herdr integration status` says it is absent and uninstalls it again,
// and deletes the Pi session files it created (`finally` also sweeps every
// Pi and Claude store dir of a folder under the temp root, so a failed run
// leaks nothing). For Claude Code it is
// `~/.claude/hooks/herdr-agent-state.sh` plus hook entries in
// `~/.claude/settings.json`: installed only when absent, uninstalled again,
// and `settings.json` is restored byte-for-byte from a copy taken before the
// install (the script refuses to finish if it differs).
// Spends a few tokens (needs a logged-in `pi` and `claude`). Stops every
// server it started; run from anywhere:
//
//   node scripts/record-herdr-fixtures.mjs [--herdr <path>] [--out <dir>] [--keep-temp]

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const HERDR = flag("--herdr") ?? "herdr";
const KEEP_TEMP = args.includes("--keep-temp");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Under /tmp, not os.tmpdir(): herdr's unix socket path (sessions/<name>/herdr.sock)
// must stay under the ~104 byte sun_path limit.
const temp = realpathSync(mkdtempSync(join("/tmp", "hm-herdr-")));
const cfg = join(temp, "cfg");
mkdirSync(cfg, { recursive: true });
const env = { ...process.env, XDG_CONFIG_HOME: cfg };
for (const name of Object.keys(env)) {
  if (name.startsWith("HERDR_")) delete env[name];
}

function herdr(argv, { json = true, allowFail = false } = {}) {
  const result = spawnSync(HERDR, argv, { env, encoding: "utf8" });
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `herdr ${argv.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  if (!json) return result.stdout;
  try {
    return JSON.parse(result.stdout);
  } catch {
    if (allowFail) return undefined;
    throw new Error(`herdr ${argv.join(" ")}: not JSON: ${result.stdout}`);
  }
}

function git(argv, cwd) {
  const result = spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0)
    throw new Error(`git ${argv.join(" ")}: ${result.stderr}`);
}

const servers = [];
function startServer(session) {
  const argv =
    session === "default" ? ["server"] : ["--session", session, "server"];
  const child = spawn(HERDR, argv, { env, stdio: "ignore" });
  servers.push({ session, child });
}
function stopServer(session) {
  const argv =
    session === "default"
      ? ["server", "stop"]
      : ["--session", session, "server", "stop"];
  herdr(argv, { json: false, allowFail: true });
}
async function waitFor(what, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

function listPaneSessions(file) {
  try {
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    return snapshot.workspaces.flatMap((workspace) =>
      workspace.tabs.flatMap((tab) =>
        Object.values(tab.panes).flatMap((pane) =>
          pane.agent_session ? [pane.agent_session] : [],
        ),
      ),
    );
  } catch {
    return [];
  }
}

/** Starts a `kind` agent (`pi`, `claude`) in `pane` of `session` and prompts it. */
async function startAgent(kind, session, pane, prompts) {
  const prefix = session === "default" ? [] : ["--session", session];
  const name = `${kind}-${session}`;
  const start = [
    ...prefix,
    "agent",
    "start",
    name,
    "--kind",
    kind,
    "--pane",
    pane,
    "--timeout",
    "90000",
  ];
  try {
    herdr(start);
  } catch (error) {
    // Claude Code asks whether to trust a new folder before it takes input
    // (herdr: "blocked during startup"). Inside herdr the cursor starts on
    // "No, exit": answer like a user, Down to "Yes, I trust this folder",
    // then Enter.
    const screen = herdr([...prefix, "agent", "read", name], {
      json: false,
      allowFail: true,
    });
    if (kind !== "claude" || !/trust this folder/i.test(screen ?? "")) {
      throw error;
    }
    herdr([...prefix, "agent", "send-keys", name, "down"], { json: false });
    await sleep(500);
    herdr([...prefix, "agent", "send-keys", name, "enter"], { json: false });
    herdr(
      [
        ...prefix,
        "agent",
        "wait",
        name,
        "--until",
        "idle",
        "--timeout",
        "60000",
      ],
      { json: false },
    );
  }
  for (const prompt of prompts) {
    herdr([
      ...prefix,
      "agent",
      "prompt",
      name,
      prompt,
      "--wait",
      "--timeout",
      "180000",
    ]);
  }
}

/** Claude's project dir name for a cwd (`/` and `.` become `-`). */
const claudeSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const piSessionFiles = new Set();
let installedPiIntegration = false;
let installedClaudeIntegration = false;
const claudeSettings = join(
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  "settings.json",
);
const claudeSettingsBefore = existsSync(claudeSettings)
  ? readFileSync(claudeSettings)
  : undefined;
/** Pi's and Claude's store dirs for every folder under the temp root (swept in `finally`, success or not). */
function sweepAgentStores() {
  const piSessions = join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "sessions",
  );
  const claudeProjects = join(dirname(claudeSettings), "projects");
  const piPrefix = `--${temp.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}-`;
  const claudePrefix = `${claudeSlug(temp)}-`;
  for (const [root, prefix] of [
    [piSessions, piPrefix],
    [claudeProjects, claudePrefix],
  ]) {
    let names = [];
    try {
      names = readdirSync(root);
    } catch {}
    for (const name of names) {
      if (name.startsWith(prefix)) {
        rmSync(join(root, name), { recursive: true, force: true });
      }
    }
  }
}
let failure;

try {
  const version = /(\d+\.\d+\.\d+\S*)/.exec(
    spawnSync(HERDR, ["--version"], { encoding: "utf8" }).stdout,
  )?.[1];
  if (!version) throw new Error("cannot read `herdr --version`");
  const out =
    flag("--out") ??
    join(
      ROOT,
      "packages",
      "core",
      "tests",
      "fixtures",
      "import",
      "herdr",
      version,
    );

  // The temp project: a repo, a linked worktree for the default session, one
  // for the named session, and a plain folder.
  const repo = join(temp, "billing-service");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
  const worktree = join(temp, "worktrees", "billing-rework");
  const scratchTree = join(temp, "worktrees", "scratch-notes");
  const claudeTree = join(temp, "worktrees", "claude-review");
  git(["worktree", "add", "-q", "-b", "billing-rework", worktree], repo);
  git(["worktree", "add", "-q", "-b", "scratch-notes", scratchTree], repo);
  git(["worktree", "add", "-q", "-b", "claude-review", claudeTree], repo);

  const plain = join(temp, "plain-folder");
  mkdirSync(plain);

  const status = herdr(["integration", "status"], { json: false });
  if (/^pi: not installed/m.test(status)) {
    herdr(["integration", "install", "pi"], { json: false });
    installedPiIntegration = true;
  }
  if (/^claude: not installed/m.test(status)) {
    herdr(["integration", "install", "claude"], { json: false });
    installedClaudeIntegration = true;
  }

  startServer("default");
  await waitFor("the default server", () =>
    herdr(["workspace", "list"], { allowFail: true }),
  );
  startServer("scratch");
  await waitFor("the scratch server", () =>
    herdr(["--session", "scratch", "workspace", "list"], { allowFail: true }),
  );

  // Default session.
  const billing = herdr([
    "workspace",
    "create",
    "--cwd",
    worktree,
    "--label",
    "Billing rework",
    "--no-focus",
  ]).result;
  await startAgent("pi", "default", billing.root_pane.pane_id, [
    "Reply with exactly the word OK.",
    "Reply with exactly the word TWO.",
    "Reply with exactly the word THREE.",
  ]);
  herdr([
    "tab",
    "create",
    "--workspace",
    billing.workspace.workspace_id,
    "--cwd",
    repo,
    "--label",
    "tests",
    "--no-focus",
  ]);
  herdr(["workspace", "create", "--cwd", plain, "--no-focus"]);
  const review = herdr([
    "workspace",
    "create",
    "--cwd",
    claudeTree,
    "--label",
    "Claude review",
    "--no-focus",
  ]).result;
  await startAgent("claude", "default", review.root_pane.pane_id, [
    "Reply with exactly the word OK.",
    "Reply with exactly the word TWO.",
    "Reply with exactly the word THREE.",
  ]);

  // Named session.
  const notes = herdr([
    "--session",
    "scratch",
    "workspace",
    "create",
    "--cwd",
    scratchTree,
    "--label",
    "Scratch notes",
    "--no-focus",
  ]).result;
  await startAgent("pi", "scratch", notes.root_pane.pane_id, [
    "Reply with exactly the word OK.",
  ]);

  // Wait until herdr has persisted the agent sessions.
  const defaultFile = join(cfg, "herdr", "session.json");
  const scratchFile = join(cfg, "herdr", "sessions", "scratch", "session.json");
  await waitFor(
    "persisted default session",
    () =>
      listPaneSessions(defaultFile).some((s) => s.agent === "pi") &&
      listPaneSessions(defaultFile).some((s) => s.agent === "claude") &&
      JSON.parse(readFileSync(defaultFile, "utf8")).workspaces.length === 3,
  );
  await waitFor(
    "persisted scratch session",
    () => listPaneSessions(scratchFile).length > 0,
  );
  for (const file of [defaultFile, scratchFile]) {
    for (const session of listPaneSessions(file)) {
      if (session.kind === "path" && session.agent === "pi") {
        piSessionFiles.add(session.value);
      }
    }
  }

  const liveDefault = herdr(["api", "snapshot"], { json: false });
  const liveScratch = herdr(["--session", "scratch", "api", "snapshot"], {
    json: false,
  });
  const listRunning = herdr(["session", "list", "--json"], { json: false });

  stopServer("scratch");
  await waitFor("the scratch server to stop", () => {
    const list = herdr(["session", "list", "--json"]);
    return list.sessions.find((s) => s.name === "scratch")?.running === false;
  });
  const listStopped = herdr(["session", "list", "--json"], { json: false });
  const defaultText = readFileSync(defaultFile, "utf8");
  const scratchText = readFileSync(scratchFile, "utf8");

  const scrub = (text) =>
    text
      .split(temp)
      .join("__ROOT__")
      .split(realpathSync(homedir()))
      .join("__HOME__")
      // Terminal titles of shell panes read `user@host:<cwd>`.
      .split(`${userInfo().username}@${hostname().split(".")[0]}`)
      .join("user@host");

  rmSync(out, { recursive: true, force: true });
  const put = (name, text) => {
    const path = join(out, name);
    mkdirSync(dirname(path), { recursive: true });
    const scrubbed = scrub(text);
    if (
      scrubbed.includes(homedir()) ||
      scrubbed.includes("/private/tmp") ||
      scrubbed.includes(userInfo().username)
    ) {
      throw new Error(`${name}: an absolute path survived scrubbing`);
    }
    writeFileSync(path, scrubbed.endsWith("\n") ? scrubbed : `${scrubbed}\n`);
  };
  put("cfg/herdr/session.json", defaultText);
  put("cfg/herdr/sessions/scratch/session.json", scratchText);
  put("session-list.json", listRunning);
  put("session-list-scratch-stopped.json", listStopped);
  put("api-snapshot-default.json", liveDefault);
  put("api-snapshot-scratch.json", liveScratch);
  put(
    "meta.json",
    `${JSON.stringify(
      {
        herdr: version,
        recordedAt: new Date().toISOString(),
        agents: ["pi", "claude"],
        note: "temp XDG_CONFIG_HOME; absolute paths rewritten to __ROOT__ / __HOME__",
      },
      null,
      2,
    )}\n`,
  );
  // Same formatting as every other JSON in the repo (biome), content unchanged.
  spawnSync("npx", ["biome", "format", "--write", out], {
    cwd: ROOT,
    stdio: "ignore",
  });
  console.log(`recorded herdr ${version} fixtures in ${out}`);
} catch (error) {
  failure = error;
} finally {
  stopServer("scratch");
  stopServer("default");
  await sleep(1500);
  for (const { child } of servers) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (installedPiIntegration) {
    herdr(["integration", "uninstall", "pi"], { json: false, allowFail: true });
  }
  if (installedClaudeIntegration) {
    herdr(["integration", "uninstall", "claude"], {
      json: false,
      allowFail: true,
    });
  }
  // The user's Claude settings come back exactly as they were.
  if (claudeSettingsBefore !== undefined) {
    const after = existsSync(claudeSettings)
      ? readFileSync(claudeSettings)
      : undefined;
    if (!after?.equals(claudeSettingsBefore)) {
      writeFileSync(claudeSettings, claudeSettingsBefore);
      console.log(`restored ${claudeSettings} from the pre-install copy`);
    }
    if (!readFileSync(claudeSettings).equals(claudeSettingsBefore)) {
      failure ??= new Error(`${claudeSettings} differs from before the run`);
    }
  }
  sweepAgentStores();
  for (const file of piSessionFiles) {
    rmSync(file, { force: true });
    const dir = dirname(file);
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {}
  }
  if (!KEEP_TEMP) rmSync(temp, { recursive: true, force: true });
  else console.log(`kept ${temp}`);
}
if (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exit(1);
}
