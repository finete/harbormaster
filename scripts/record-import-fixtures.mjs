#!/usr/bin/env node
// Records REAL import fixtures (docs/import.md "Fixtures and tests"): runs
// each installed, logged-in agent CLI (Pi, Claude Code, Codex, Cursor) in a
// pty, with the adapter's own launch spec, inside a temp git repository's
// linked worktree, for a few short prompts (>= 3, so the item is not
// "tiny") and a session title produced by the CLI itself. It then COPIES
// the store files the recording created into
//
//   packages/core/tests/fixtures/import/<harness>/<version>/
//
// (store-relative paths; absolute paths rewritten to `__ROOT__` / `__HOME__`,
// emails and account ids redacted, long string values trimmed so no system
// prompt or personal instruction file leaks) and DELETES what the recording
// created from the user's real stores. Nothing is hand-written.
//
// `--harness processes` records the process-table fixture instead: one live
// agent of every harness idling in the worktree, the raw `ps` / `lsof`
// output (trimmed to agent-related lines) and Claude's
// `~/.claude/sessions/<pid>.json`, into `fixtures/import/processes/`.
//
// Needs logged-in CLIs and spends a few tokens per prompt. Usage (repo root,
// after `npm run build -w @harbormaster/core`):
//
//   node scripts/record-import-fixtures.mjs --harness all
//   node scripts/record-import-fixtures.mjs --harness claude-code [--out <dir>]
//   node scripts/record-import-fixtures.mjs --harness processes

import { execFileSync } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cliVersion,
  killStragglers,
  resolveBinary,
  runTurn,
  settle,
  sleep,
  startSession,
  waitFor,
} from "./record-harness-status.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "packages", "core", "tests", "fixtures", "import");
const HOME = realpathSync(homedir());

export const HARBORS = ["pi", "claude-code", "codex", "cursor"];

export const PROMPTS = [
  "Reply with exactly the word ONE and nothing else.",
  "Reply with exactly the word TWO and nothing else.",
  "Reply with exactly the word THREE and nothing else.",
];

/** What each store keeps, relative to its root: watched for new files. */
const STORES = {
  pi: {
    root: () => process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi", "agent"),
    watch: ["sessions"],
  },
  "claude-code": {
    root: () => process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"),
    watch: ["projects", "sessions"],
  },
  codex: {
    root: () => process.env.CODEX_HOME ?? join(HOME, ".codex"),
    watch: ["sessions", "thread-writer-locks"],
  },
  cursor: {
    root: () =>
      process.env.CURSOR_CONFIG_DIR ??
      (process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "cursor")
        : join(HOME, ".cursor")),
    watch: ["chats", "projects"],
  },
};

/** Files copied into a fixture (the rest of what a run creates is only deleted). */
const KEEP = {
  pi: (rel) => rel.endsWith(".jsonl"),
  "claude-code": (rel) =>
    (rel.startsWith("projects/") && rel.endsWith(".jsonl")) ||
    // The running registry is recorded with the process fixture, not here.
    false,
  codex: (rel) => rel.endsWith(".jsonl"),
  cursor: (rel) =>
    rel.endsWith("/meta.json") ||
    rel.endsWith("/prompt_history.json") ||
    rel.includes("/agent-transcripts/"),
};

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key, "true");
    else {
      flags.set(key, next);
      i++;
    }
  }
  return flags;
}

/** `root/repo` (main checkout) and `root/wt` (linked worktree on branch `import-fixture`). */
function makeRepoWithWorktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hm-import-")));
  const main = join(root, "repo");
  const wt = join(root, "wt");
  mkdirSync(main);
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "# scratch\n");
  git(main, "add", ".");
  git(
    main,
    "-c",
    "user.name=recorder",
    "-c",
    "user.email=recorder@example.invalid",
    "commit",
    "-q",
    "-m",
    "init",
  );
  git(main, "worktree", "add", "-q", "-b", "import-fixture", wt);
  return { root, main, wt };
}

// --- store snapshots and cleanup ---------------------------------------------

function walk(dir, files, dirs) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.add(path);
      walk(path, files, dirs);
    } else if (entry.isFile()) files.add(path);
  }
}

function snapshot(harnesses) {
  const files = new Set();
  const dirs = new Set();
  for (const harness of harnesses) {
    const store = STORES[harness];
    for (const sub of store.watch) walk(join(store.root(), sub), files, dirs);
  }
  return { files, dirs };
}

/** Files and directories created since `before` (directories deepest first). */
function createdSince(before, harnesses) {
  const after = snapshot(harnesses);
  return {
    files: [...after.files].filter((path) => !before.files.has(path)),
    dirs: [...after.dirs]
      .filter((path) => !before.dirs.has(path))
      .sort((a, b) => b.length - a.length),
  };
}

function deleteCreated(created) {
  for (const file of created.files) rmSync(file, { force: true });
  for (const dir of created.dirs) {
    try {
      rmdirSync(dir);
    } catch {}
  }
}

/** Removes temp-root traces from the shared config files the CLIs touch (trust entries, history lines). */
function scrubSharedFiles(root, notes) {
  const mentions = (text) => text.includes(root);
  // Claude: ~/.claude.json keeps a per-project entry (trust dialog answer).
  const claudeJson = join(
    process.env.CLAUDE_CONFIG_DIR ?? HOME,
    process.env.CLAUDE_CONFIG_DIR ? ".claude.json" : ".claude.json",
  );
  try {
    const data = JSON.parse(readFileSync(claudeJson, "utf8"));
    let changed = false;
    for (const key of Object.keys(data.projects ?? {})) {
      if (key.startsWith(root)) {
        delete data.projects[key];
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(claudeJson, JSON.stringify(data, null, 2));
      notes.push("removed the temp project's entry from ~/.claude.json");
    }
  } catch {}
  // Line-oriented histories: drop the lines that name the temp root.
  for (const [path, label] of [
    [join(STORES["claude-code"].root(), "history.jsonl"), "claude history"],
    [join(STORES.codex.root(), "history.jsonl"), "codex history"],
    [join(STORES.codex.root(), "session_index.jsonl"), "codex index"],
  ]) {
    try {
      const lines = readFileSync(path, "utf8").split("\n");
      const kept = lines.filter((line) => !mentions(line));
      if (kept.length !== lines.length) {
        writeFileSync(path, kept.join("\n"));
        notes.push(`${label}: dropped ${lines.length - kept.length} line(s)`);
      }
    } catch {}
  }
  // Codex: [projects."<path>"] trust stanza in config.toml.
  try {
    const path = join(STORES.codex.root(), "config.toml");
    const text = readFileSync(path, "utf8");
    const stanza = new RegExp(
      `\\n?\\[projects\\."${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"\\]\\n(?:[^\\[\\n][^\\n]*\\n?)*`,
      "g",
    );
    const next = text.replace(stanza, "\n");
    if (next !== text) {
      writeFileSync(path, next);
      notes.push(
        "removed the temp project's trust entries from codex config.toml",
      );
    }
  } catch {}
}

// --- fixture writing ------------------------------------------------------------

const slugClaude = (path) => path.replace(/[/.]/g, "-");
const slugPi = (path) =>
  `--${path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Placeholder rewriting for text: temp root and home, in plain and slug spellings. */
function placeholderRewriter(root) {
  const pairs = [];
  const add = (from, to) => from && pairs.push([from, to]);
  for (const variant of new Set([root, root.replace(/^\/private/, "")])) {
    add(slugPi(variant), "--__ROOT__--");
    add(slugClaude(variant), "-__ROOT__");
    add(variant, "__ROOT__");
  }
  add(slugClaude(HOME), "-__HOME__");
  add(HOME, "__HOME__");
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out;
  };
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const ID_KEYS =
  /(account|user|organization|creator_user|creator_account)_?(id|uuid)$|email|installation|machine_?id/i;

/** Trims long strings and redacts account identifiers inside one parsed JSON value. */
function scrubValue(value, key = "") {
  if (typeof value === "string") {
    if (ID_KEYS.test(key)) return "<redacted>";
    if (value.length > 400) return `<trimmed:${value.length}>`;
    return value.replace(EMAIL, "user@example.invalid");
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubValue(v, k)]),
    );
  }
  return value;
}

/**
 * Entries that only dump the user's environment (tool/skill/MCP listings,
 * git config, system prompts) and nothing an import reader looks at: left
 * out of the fixture so no personal setup is committed.
 */
const ENVIRONMENT_ATTACHMENTS = new Set([
  "deferred_tools_delta",
  "mcp_instructions_delta",
  "skill_listing",
  "agent_listing_delta",
  "session_context",
  "prompt_snapshot",
  "remote_session_change",
  "credential_org",
  "model",
]);

function isEnvironmentDump(entry) {
  if (typeof entry?.type === "string" && entry.type.startsWith("api-request")) {
    return true;
  }
  return (
    entry?.type === "attachment" &&
    ENVIRONMENT_ATTACHMENTS.has(entry.attachment?.type)
  );
}

/** One file's fixture text: placeholders first, then (JSON / JSONL) value scrubbing. */
function rewriteFile(path, rewrite) {
  const text = rewrite(readFileSync(path, "utf8"));
  const scrubJson = (line) => {
    const entry = JSON.parse(line);
    return isEnvironmentDump(entry)
      ? undefined
      : JSON.stringify(scrubValue(entry));
  };
  if (path.endsWith(".jsonl")) {
    return `${text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return scrubJson(line);
        } catch {
          return line;
        }
      })
      .filter((line) => line !== undefined)
      .join("\n")}\n`;
  }
  if (path.endsWith(".json")) {
    try {
      return `${JSON.stringify(scrubValue(JSON.parse(text)), null, 2)}\n`;
    } catch {}
  }
  return text.replace(EMAIL, "user@example.invalid");
}

/** Cursor's chat dir is named md5(cwd): a placeholder keeps the fixture path-independent. */
function fixtureRelative(harness, rel, rewrite) {
  let out = rewrite(rel);
  if (harness === "cursor") {
    out = out.replace(/^chats\/[0-9a-f]{32}\//, "chats/__CWD_HASH__/");
  }
  return out;
}

// --- driving a CLI ----------------------------------------------------------------

const EXIT_KEYS = {
  "claude-code": ["/exit\r"],
  pi: ["/quit\r"],
  codex: ["/quit", "\r"],
  cursor: ["\x04", "\x04"],
};

/** The CLI-native way to give the session a title, typed like a user (absent = the CLI titles it itself). */
const TITLE_COMMANDS = {
  pi: "/name Import fixture session",
  // Claude: `/rename` with no argument asks the model for a name.
  "claude-code": "/rename",
  codex: "/rename Import fixture thread",
};

async function typeLine(session, text) {
  session.proc.write(text);
  await sleep(500);
  session.proc.write("\r");
}

async function recordHarness({ core, harness, outDir, keepTemp }) {
  const registry = core.createHarnessRegistry({});
  let adapter = registry.get(harness);
  const binary = resolveBinary(adapter, undefined);
  const version = cliVersion(adapter, binary);
  const { root, wt } = makeRepoWithWorktree();
  const stateDir = mkdtempSync(join(tmpdir(), "hm-import-state-"));
  const notes = [];
  const hooksProtocol = adapter.capabilities.status.protocol === "hooks";
  let hookLog;
  if (hooksProtocol) {
    const { writeHookLogger } = await import("./record-harness-status.mjs");
    hookLog = join(stateDir, "hooks.jsonl");
    adapter = core
      .createHarnessRegistry({
        stateDir,
        cliPath: writeHookLogger(stateDir, hookLog),
      })
      .get(harness);
  }
  const extraArgs =
    harness === "codex"
      ? [
          "-c",
          'model_reasoning_effort="low"',
          "-c",
          "notify=[]",
          "-c",
          "check_for_update_on_startup=false",
        ]
      : [];
  const before = snapshot([harness]);
  console.log(`${harness} ${version}: recording in ${wt}`);
  const session = startSession({
    core,
    adapter,
    binary,
    workspace: wt,
    stateDir,
    extraArgs,
    hookLog,
  });
  session.hooksProtocol = hooksProtocol;
  const ctx = { notes, timeoutMs: 180_000, approve: false };
  try {
    await settle(session, harness, notes);
    for (const prompt of PROMPTS) {
      await runTurn(session, prompt, ctx);
      await sleep(1500);
    }
    if (TITLE_COMMANDS[harness]) {
      await typeLine(session, TITLE_COMMANDS[harness]);
      // Claude's /rename asks the model; the others write at once.
      await sleep(harness === "claude-code" ? 12_000 : 3000);
    } else {
      await sleep(4000); // Cursor titles the chat after the first turn
    }
    for (const key of EXIT_KEYS[harness]) {
      session.proc.write(key);
      await sleep(400);
    }
    await waitFor(() => session.exited, 15_000);
  } finally {
    session.kill();
    killStragglers(wt);
  }
  await sleep(1500);

  const created = createdSince(before, [harness]);
  const store = STORES[harness].root();
  const rewrite = placeholderRewriter(root);
  const dest = join(outDir, harness, version);
  rmSync(dest, { recursive: true, force: true });
  const copied = [];
  // Codex appends one line per session to session_index.jsonl: copy the lines
  // that name this recording's sessions (found through the rollout ids).
  const ids = created.files
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/)?.[0])
    .filter(Boolean);
  for (const file of created.files) {
    const rel = relative(store, file);
    if (!KEEP[harness](rel)) continue;
    const target = join(dest, fixtureRelative(harness, rel, rewrite));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rewriteFile(file, rewrite));
    copied.push(relative(dest, target));
  }
  if (harness === "codex") {
    try {
      const index = readFileSync(join(store, "session_index.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line && ids.some((id) => line.includes(id)));
      if (index.length > 0) {
        const target = join(dest, "session_index.jsonl");
        // The real index loses this recording's lines too.
        const indexPath = join(store, "session_index.jsonl");
        const rest = readFileSync(indexPath, "utf8")
          .split("\n")
          .filter((line) => !ids.some((id) => line.includes(id)));
        writeFileSync(indexPath, rest.join("\n"));
        writeFileSync(
          target,
          `${index.map((line) => JSON.stringify(scrubValue(JSON.parse(line)))).join("\n")}\n`,
        );
        copied.push("session_index.jsonl");
      }
    } catch {}
  }
  const meta = {
    harness,
    version,
    recordedAt: new Date().toISOString(),
    prompts: PROMPTS,
    titleCommand: TITLE_COMMANDS[harness] ?? "(the CLI's own)",
    placeholders: { __ROOT__: "the temp root", __HOME__: "the home folder" },
    worktree: "__ROOT__/wt",
    mainCheckout: "__ROOT__/repo",
    files: copied,
    notes,
  };
  mkdirSync(dest, { recursive: true });
  writeFileSync(
    join(dest, "recording.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  deleteCreated(created);
  scrubSharedFiles(root, notes);
  if (!keepTemp) {
    execFileSync("git", ["worktree", "prune"], { cwd: join(root, "repo") });
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(
    `${harness}: ${copied.length} fixture file(s) -> ${relative(ROOT, dest)}${notes.length ? `; ${notes.join("; ")}` : ""}`,
  );
}

// --- process fixture ----------------------------------------------------------------

/** Agent-related lines only: the rest of a real process table is the user's. */
const AGENT_LINE =
  /(^|\s)(pi|claude)\s|vendor\/.*\/bin\/codex|cursor-agent\/versions\/|\/bin\/codex\s+app-server|\.local\/bin\/agent/;

async function recordProcesses({ core, outDir, keepTemp }) {
  const { root, wt } = makeRepoWithWorktree();
  const stateDir = mkdtempSync(join(tmpdir(), "hm-import-state-"));
  const before = snapshot(HARBORS);
  const sessions = [];
  const notes = [];
  const versions = {};
  try {
    for (const harness of HARBORS) {
      let adapter = core.createHarnessRegistry({}).get(harness);
      const binary = resolveBinary(adapter, undefined);
      versions[harness] = cliVersion(adapter, binary);
      let hookLog;
      if (adapter.capabilities.status.protocol === "hooks") {
        const { writeHookLogger } = await import("./record-harness-status.mjs");
        hookLog = join(stateDir, "hooks.jsonl");
        adapter = core
          .createHarnessRegistry({
            stateDir,
            cliPath: writeHookLogger(stateDir, hookLog),
          })
          .get(harness);
      }
      const session = startSession({
        core,
        adapter,
        binary,
        workspace: wt,
        stateDir,
        extraArgs:
          harness === "codex"
            ? ["-c", "notify=[]", "-c", "check_for_update_on_startup=false"]
            : [],
        hookLog,
      });
      session.hooksProtocol = Boolean(hookLog);
      sessions.push(session);
      await settle(session, harness, notes);
      notes.push(`${harness} pid ${session.proc.pid} exited=${session.exited}`);
      if (session.exited) notes.push(session.screen().slice(-400));
    }
    await sleep(3000);
    const ps = execFileSync("ps", ["-axo", "pid=,lstart=,comm=,args="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(
        (line) =>
          AGENT_LINE.test(line) ||
          sessions.some((s) => line.trim().startsWith(`${s.proc.pid} `)),
      );
    const pids = ps.map((line) => line.trim().split(/\s+/)[0]).join(",");
    let lsof = "";
    try {
      lsof = execFileSync("lsof", ["-a", "-d", "cwd", "-p", pids, "-Fpn"], {
        encoding: "utf8",
      });
    } catch (error) {
      lsof = error.stdout?.toString() ?? "";
    }
    const registry = join(STORES["claude-code"].root(), "sessions");
    const registryFiles = existsSync(registry)
      ? readdirSync(registry).filter((name) => name.endsWith(".json"))
      : [];
    const rewrite = placeholderRewriter(root);
    const dest = join(outDir, "processes");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, "claude-sessions"), { recursive: true });
    // Processes of the user's own sessions are anonymized: their cwd names
    // become `__HOME__/other/<pid>`, and their (long) command lines are cut
    // after the part that identifies the agent.
    const ownPids = new Set();
    const lsofLines = rewrite(lsof).split("\n");
    let current;
    const anonymized = lsofLines.map((line) => {
      if (line.startsWith("p")) current = line.slice(1);
      if (line.startsWith("n")) {
        if (line.startsWith("n__ROOT__")) ownPids.add(current);
        else return `n__HOME__/other/${current}`;
      }
      return line;
    });
    const psText = ps
      .map((line) => rewrite(line))
      .map((line) =>
        ownPids.has(line.trim().split(/\s+/)[0]) ? line : line.slice(0, 220),
      );
    writeFileSync(join(dest, "ps.txt"), `${psText.join("\n")}\n`);
    writeFileSync(join(dest, "lsof.txt"), anonymized.join("\n"));
    const live = new Set(ps.map((line) => line.trim().split(/\s+/)[0]));
    let registryKept = 0;
    for (const name of registryFiles) {
      const path = join(registry, name);
      if (!live.has(name.replace(/\.json$/, ""))) continue;
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (!String(data.cwd).startsWith(root)) continue; // only the recording's own
      writeFileSync(
        join(dest, "claude-sessions", name),
        rewriteFile(path, rewrite),
      );
      registryKept++;
    }
    writeFileSync(
      join(dest, "recording.json"),
      `${JSON.stringify(
        {
          versions,
          recordedAt: new Date().toISOString(),
          // `ps lstart` is local time: the replay test parses it in this zone.
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          command:
            "ps -axo pid=,lstart=,comm=,args=  |  lsof -a -d cwd -p <pids> -Fpn",
          worktree: "__ROOT__/wt",
          claudeRegistryFiles: registryKept,
          note: "ps is trimmed to agent-related lines; Claude's registry to the recording's own session",
          notes,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `processes: ${ps.length} agent line(s) -> ${relative(ROOT, dest)}`,
    );
  } finally {
    for (const session of sessions) session.kill();
    killStragglers(wt);
    await sleep(1500);
    deleteCreated(createdSince(before, HARBORS));
    // Claude's registry entries of the killed process.
    const registry = join(STORES["claude-code"].root(), "sessions");
    for (const name of existsSync(registry) ? readdirSync(registry) : []) {
      if (!name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(registry, name), "utf8"));
        if (String(data.cwd).startsWith(root)) rmSync(join(registry, name));
      } catch {}
    }
    scrubSharedFiles(root, notes);
    if (!keepTemp) {
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: join(root, "repo") });
      } catch {}
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const which = flags.get("harness");
  if (!which) {
    console.error(
      "usage: record-import-fixtures.mjs --harness pi|claude-code|codex|cursor|processes|all [--out <dir>] [--keep-temp]",
    );
    process.exit(2);
  }
  const core = await import(join(ROOT, "packages", "core", "dist", "index.js"));
  const outDir = flags.get("out") ?? FIXTURES;
  const keepTemp = flags.get("keep-temp") === "true";
  const targets =
    which === "all" ? [...HARBORS, "processes"] : which.split(",");
  for (const target of targets) {
    if (target === "processes")
      await recordProcesses({ core, outDir, keepTemp });
    else if (HARBORS.includes(target))
      await recordHarness({ core, harness: target, outDir, keepTemp });
    else throw new Error(`unknown harness ${target}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    },
  );
}
