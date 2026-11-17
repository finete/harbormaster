#!/usr/bin/env node
// Records a harness's real OSC 7501 status dialect (docs/harness-additions.md
// S1/S2): runs the harness's own launch spec (built by core's adapter) in a
// pty inside a fresh temp git repository, answers the 7501 probe exactly as
// the app's pty layer does (`ProgramStatusParser` replies, written back into
// the pty, see packages/app/src/main/ptySessions.ts), drives one scripted
// scenario, and writes the RAW output bytes to
//
//   packages/core/tests/fixtures/status/<harness>/<version>/<scenario>.txt
//
// plus a sibling `<scenario>.json` ({ harness, version, scenario,
// recordedAt, prompts, reports, expected, ... }). `expected` is seeded from
// what was observed after the adapter's `interpretProgramStatus`; the replay
// test (packages/core/tests/status-dialect.test.ts) asserts it, so a
// re-recording that changes behavior shows up as a reviewed diff.
//
// Needs a logged-in CLI and spends a few tokens per scenario.
//
// Usage (from the repo root, after `npm run build -w @harbormaster/core`):
//
//   node scripts/record-harness-status.mjs --harness claude-code --scenario all
//   node scripts/record-harness-status.mjs --harness pi --scenario turn
//   node scripts/record-harness-status.mjs --harness claude-code \
//     --scenario background-work --version 2.1.326 [--out <dir>] [--keep-temp]
//   node scripts/record-harness-status.mjs --harness codex --scenario all \
//     --command <prefix>/node_modules/.bin/codex
//
// Scenarios: startup, turn, turn-tool, permission, cancel, background-work,
// subagent, exit. `--version` defaults to the CLI's own `--version`. The
// binary is `--command <path>` (a pinned install outside PATH, e.g. the
// real-CLI tier's npm prefix), else the descriptor's override env var, else
// its first alias found on PATH that is not a terminal-multiplexer shim
// (cmux).
// Input typed before the TUI is ready is dropped, so every scenario waits for
// the first 7501 report (or ~3 s with none) before typing; Enter is "\r".
// Claude's folder-trust dialog is answered like a user (Enter on "Yes, I
// trust this folder"), and Codex's ("Trust this folder?", Enter on "Trust
// and continue"; Codex then records the folder in ~/.codex/config.toml). Output after the last 7501 report is truncated so a
// fixture stays small.

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "packages", "core", "tests", "fixtures", "status");

export const SCENARIOS = [
  "startup",
  "turn",
  "turn-tool",
  "permission",
  "cancel",
  "background-work",
  "subagent",
  "exit",
];

/** The prompt each scenario types (absent = it types none). */
export const SCENARIO_PROMPTS = {
  turn: "Reply with exactly the word OK and nothing else.",
  "turn-tool":
    "Run `ls` with your shell tool, then reply with exactly the word DONE.",
  permission:
    "Create a file named hello.txt containing the word hi. Do nothing else.",
  cancel:
    "Count from 1 to 300, one number per line, with no other text. Do not use any tools.",
  "background-work":
    "Run `sleep 120` in the background, then reply with exactly the word DONE",
  subagent:
    "Use a subagent (the Task/Agent tool) to run `echo hi` and report its output, then reply with exactly the word DONE.",
};

/** How each harness leaves its TUI (the exit scenario). */
const EXIT_KEYS = { "claude-code": "/exit\r", pi: "/quit\r", codex: "/quit" };

/**
 * Extra launch args per harness and scenario. A user whose own settings
 * allow every tool never sees a permission prompt, so the permission
 * scenario turns `Write` back into an "ask" rule for this session only
 * (ask beats allow in Claude's precedence).
 */
const SCENARIO_ARGS = {
  // Codex: no approval prompt inside the workspace sandbox by default
  // (and `approval_policy="untrusted"` is rejected on 0.169.0), so the
  // permission scenario runs read-only: writing the file needs approval.
  codex: {
    permission: ["-s", "read-only", "-a", "on-request"],
  },
  "claude-code": {
    permission: [
      "--settings",
      JSON.stringify({ permissions: { ask: ["Write", "Edit", "Bash"] } }),
    ],
  },
};

/**
 * Extra launch args per harness for every scenario. Codex: low reasoning
 * effort (fast, cheap turns; the dialect does not depend on it) and no
 * user `notify` program (a user's turn-ended hook stays out of the
 * recording).
 */
const HARNESS_ARGS = {
  codex: ["-c", 'model_reasoning_effort="low"', "-c", "notify=[]"],
};

const MAX_FIXTURE_BYTES = 200 * 1024;

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key, "true");
    else {
      flags.set(key, next);
      i++;
    }
  }
  return flags;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The descriptor's binary: `--command`, an override env var, else the first non-shim PATH hit. */
function resolveBinary(adapter, command) {
  if (command) return command;
  for (const name of adapter.descriptor.commandEnv) {
    if (process.env[name]) return process.env[name];
  }
  for (const [binary] of adapter.descriptor.commands) {
    if (isAbsolute(binary)) return binary;
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, binary);
      if (!isExecutable(candidate)) continue;
      if (adapter.descriptor.isShim?.(candidate)) continue;
      return candidate;
    }
  }
  throw new Error(`${adapter.descriptor.label}: no binary found on PATH`);
}

function cliVersion(adapter, binary) {
  const out = execFileSync(binary, adapter.descriptor.versionArgs, {
    encoding: "utf8",
    timeout: 30_000,
  });
  const version = adapter.descriptor.parseVersion(out);
  if (!version) throw new Error(`cannot parse version from: ${out}`);
  return version;
}

/** A throwaway git repository standing in for a task worktree. */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "hm-status-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# scratch\n");
  git("add", ".");
  git(
    "-c",
    "user.name=recorder",
    "-c",
    "user.email=recorder@example.invalid",
    "commit",
    "-q",
    "-m",
    "init",
  );
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pty session: raw bytes recorded, probes answered like the app, 7501
 * reports collected, the screen mirrored by a headless xterm.
 */
function startSession({
  core,
  adapter,
  binary,
  workspace,
  stateDir,
  extraArgs,
}) {
  const pty = require("node-pty");
  const { Terminal } = require("@xterm/headless");
  const spec = adapter.buildLaunchSpec({
    taskId: "status-recording",
    workspacePath: workspace,
    stateDir,
  });
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never let a surrounding Harbormaster session's identity leak in.
    if (key.startsWith("HARBORMASTER_") || key.startsWith("CMUX")) continue;
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, spec.env, { TERM: "xterm-256color" });
  const cols = 120;
  const rows = 40;
  const proc = pty.spawn(binary, [...extraArgs, ...spec.args], {
    cwd: spec.cwd,
    env,
    cols,
    rows,
    name: "xterm-256color",
  });
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  const parser = new core.ProgramStatusParser();
  const chunks = [];
  const reports = [];
  let lastReportEnd = 0;
  let bytes = 0;
  let probes = 0;
  let exited = false;
  const startedAt = Date.now();
  proc.onData((data) => {
    chunks.push(data);
    bytes += data.length;
    const result = parser.feed(data);
    for (const reply of result.replies) {
      probes++;
      try {
        proc.write(reply);
      } catch {}
    }
    for (const report of result.reports) {
      reports.push({ ...report, ms: Date.now() - startedAt });
    }
    if (result.reports.length > 0) lastReportEnd = chunks.length;
    terminal.write(result.output);
  });
  proc.onExit(() => {
    exited = true;
  });
  const screen = () => {
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let y = 0; y < buffer.length; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  };
  return {
    proc,
    reports,
    screen,
    get probes() {
      return probes;
    },
    get exited() {
      return exited;
    },
    /** The raw stream, cut after the last 7501 report when over the cap. */
    raw() {
      let text = chunks.join("");
      let truncated = false;
      if (Buffer.byteLength(text) > MAX_FIXTURE_BYTES) {
        text = chunks.slice(0, Math.max(lastReportEnd, 1)).join("");
        truncated = true;
        if (Buffer.byteLength(text) > MAX_FIXTURE_BYTES) {
          // Keep the tail: every report is in the stream's last part.
          const buf = Buffer.from(text);
          text = buf.subarray(buf.length - MAX_FIXTURE_BYTES).toString();
        }
      }
      return { text, truncated, bytes };
    },
    kill() {
      // Take every descendant along (background shells the agent started,
      // e.g. `sleep 120`, run in their own session and would outlive it).
      for (const pid of descendants(proc.pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      try {
        proc.kill("SIGKILL");
      } catch {}
      terminal.dispose();
    },
  };
}

/** Every live descendant pid of `root` (from `ps`), deepest last. */
function descendants(root) {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Kills processes still running in `workspace` (a backgrounded `sleep 120` reparented to init). */
function killStragglers(workspace) {
  let pids = [];
  try {
    pids = execFileSync(
      "lsof",
      ["-t", "-a", "-d", "cwd", "+D", realpathSync(workspace)],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    // lsof exits 1 when nothing matches.
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function waitFor(predicate, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

/** Answers Claude's folder-trust dialog like a user; resolves whether it was shown. */
async function settle(session, harness, notes) {
  let trustDialog = false;
  const started = Date.now();
  const ready = await waitFor(async () => {
    const text = session.screen();
    if (/Hooks need review/.test(text) && /without trusting/.test(text)) {
      // Codex: the user's own untrusted hooks (~/.codex/hooks.json). The
      // app's launches pass --dangerously-bypass-hook-trust and never see
      // this; the recorder skips them (Esc) rather than run them.
      session.proc.write("\x1b");
      notes.push("skipped Codex's hook-review dialog (Esc)");
      await sleep(1500);
      return false;
    }
    if (/Trust this folder\?/.test(text) && /Trust and continue/.test(text)) {
      // Codex: option 1 "Trust and continue" is preselected.
      session.proc.write("\r");
      if (!trustDialog) notes.push("answered the folder-trust dialog");
      trustDialog = true;
      await sleep(1500);
      return false;
    }
    if (/Yes, I trust this folder/.test(text)) {
      const selected = text.split("\n").find((line) => line.includes("\u276f"));
      session.proc.write(selected?.includes("Yes, I trust") ? "\r" : "\x1b[B");
      if (!trustDialog) notes.push("answered the folder-trust dialog");
      trustDialog = true;
      await sleep(800);
      return false;
    }
    // Claude: its first report, past the trust dialog's own `blocked`.
    if (harness === "claude-code") {
      const latest = session.reports.at(-1);
      return !!latest && latest.state !== "blocked";
    }
    // Others (Pi reports without the probe): ~3 s for the TUI either way.
    return Date.now() - started >= 3000;
  }, 60_000);
  if (!ready) {
    notes.push("no 7501 report within 60 s of start");
  }
  // Let the startup reports finish arriving before typing.
  await sleep(1500);
  return trustDialog;
}

const isActive = (r) => r.state === "working" || r.state === "blocked";

/** Types a prompt, then waits until the turn is over (approving permission prompts when asked). */
async function runTurn(session, prompt, { timeoutMs, approve, notes }) {
  const before = session.reports.length;
  session.proc.write(prompt);
  await sleep(300);
  session.proc.write("\r");
  const started = await waitFor(
    () => session.reports.slice(before).some(isActive),
    30_000,
  );
  if (!started) notes.push("the turn never reported working");
  let approvals = 0;
  const over = await waitFor(async () => {
    const latest = session.reports.at(-1);
    if (approve && latest?.state === "blocked" && approvals < 5) {
      approvals++;
      notes.push(`approved a permission prompt (${latest.message ?? ""})`);
      await sleep(1000);
      session.proc.write("\r");
      await waitFor(() => session.reports.at(-1) !== latest, 10_000);
      return false;
    }
    const after = session.reports.slice(before);
    const last = after.at(-1);
    if (!last) return false;
    if (last.state === "done" || last.state === "error") return true;
    // Claude's background-work dialect: working + "<n> … still running".
    return /still running/.test(last.message ?? "");
  }, timeoutMs);
  if (!over) notes.push(`turn not over after ${timeoutMs} ms`);
  return over;
}

const SCENARIO_STEPS = {
  async startup() {
    await sleep(3000);
  },
  async turn(session, ctx) {
    await runTurn(session, SCENARIO_PROMPTS.turn, ctx);
    await sleep(5000); // catch trailing reports (Claude's double done / flicker)
  },
  async "turn-tool"(session, ctx) {
    await runTurn(session, SCENARIO_PROMPTS["turn-tool"], {
      ...ctx,
      approve: true,
    });
    await sleep(5000);
  },
  async permission(session, ctx) {
    const before = session.reports.length;
    session.proc.write(SCENARIO_PROMPTS.permission);
    await sleep(300);
    session.proc.write("\r");
    const blocked = await waitFor(
      () => session.reports.slice(before).some((r) => r.state === "blocked"),
      ctx.timeoutMs,
    );
    if (!blocked) ctx.notes.push("no blocked report (no permission prompt?)");
    await sleep(2000);
    session.proc.write("\x1b"); // decline with Esc
    await waitFor(
      () => !isActive(session.reports.at(-1) ?? { state: "working" }),
      20_000,
    );
    await sleep(4000);
  },
  async cancel(session, ctx) {
    const before = session.reports.length;
    session.proc.write(SCENARIO_PROMPTS.cancel);
    await sleep(300);
    session.proc.write("\r");
    const working = await waitFor(
      () => session.reports.slice(before).some((r) => r.state === "working"),
      30_000,
    );
    if (!working) ctx.notes.push("the turn never reported working");
    await sleep(2500);
    session.proc.write("\x1b");
    const settled = await waitFor(
      () => (session.reports.at(-1)?.state ?? "working") !== "working",
      20_000,
    );
    if (!settled) ctx.notes.push("still working 20 s after Esc");
    await sleep(4000);
  },
  async "background-work"(session, ctx) {
    await runTurn(session, SCENARIO_PROMPTS["background-work"], {
      ...ctx,
      approve: true,
    });
    await sleep(15000); // the lingering state while `sleep 120` still runs
  },
  async subagent(session, ctx) {
    await runTurn(session, SCENARIO_PROMPTS.subagent, {
      ...ctx,
      approve: true,
    });
    await sleep(5000);
  },
  async exit(session, ctx) {
    session.proc.write(EXIT_KEYS[ctx.harness] ?? "\x03\x03");
    await sleep(300);
    session.proc.write("\r");
    const exited = await waitFor(() => session.exited, 20_000);
    if (!exited) ctx.notes.push("process still running 20 s after the exit");
  },
};

/** The state sequence core records: each report through the adapter, repeats collapsed. */
export function expectedSequence(core, adapter, raw) {
  const parser = new core.ProgramStatusParser();
  const readings = parser.feed(raw).reports.map((report) => {
    // What core records: state + message, through the adapter.
    const reading = {
      state: report.state,
      ...(report.message ? { message: report.message } : {}),
    };
    return adapter.interpretProgramStatus?.(reading) ?? reading;
  });
  const states = [];
  for (const reading of readings) {
    if (states.at(-1) !== reading.state) states.push(reading.state);
  }
  return { states, final: readings.at(-1) };
}

async function recordScenario({
  core,
  adapter,
  harness,
  binary,
  version,
  scenario,
  outDir,
  keepTemp,
}) {
  const workspace = makeWorkspace();
  const stateDir = mkdtempSync(join(tmpdir(), "hm-status-state-"));
  const notes = [];
  const extraArgs = [
    ...(HARNESS_ARGS[harness] ?? []),
    ...(SCENARIO_ARGS[harness]?.[scenario] ?? []),
  ];
  const session = startSession({
    core,
    adapter,
    binary,
    workspace,
    stateDir,
    extraArgs,
  });
  const ctx = { harness, notes, timeoutMs: 180_000, approve: false };
  let trustDialog = false;
  try {
    trustDialog = await settle(session, harness, notes);
    await SCENARIO_STEPS[scenario](session, ctx);
  } finally {
    session.kill();
    killStragglers(workspace);
    if (!keepTemp) {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
  const { text, truncated, bytes } = session.raw();
  const dir = join(outDir, harness, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario}.txt`), text);
  const { states, final } = expectedSequence(core, adapter, text);
  const meta = {
    harness,
    version,
    scenario,
    recordedAt: new Date().toISOString(),
    prompts: SCENARIO_PROMPTS[scenario] ? [SCENARIO_PROMPTS[scenario]] : [],
    command: [
      binary.split("/").at(-1),
      ...extraArgs,
      ...adapter.buildLaunchSpec({
        taskId: "status-recording",
        workspacePath: workspace,
        stateDir,
      }).args,
    ],
    probesAnswered: session.probes,
    trustDialog,
    truncated,
    rawBytes: bytes,
    reports: session.reports.map(({ ms, ...report }) => ({ ...report, ms })),
    notes,
    // Reviewed expectations the replay test asserts (seeded from this run).
    expected: {
      states,
      ...(final ? { final } : {}),
    },
  };
  writeFileSync(
    join(dir, `${scenario}.json`),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  return meta;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const harness = flags.get("harness");
  const scenarioArg = flags.get("scenario");
  if (!harness || !scenarioArg) {
    console.error(
      "usage: record-harness-status.mjs --harness <id> --scenario <id>|all [--command <path>] [--version <x>] [--out <dir>] [--keep-temp]",
    );
    process.exit(2);
  }
  const core = await import(join(ROOT, "packages", "core", "dist", "index.js"));
  const adapter = core.createHarnessRegistry({}).get(harness);
  if (!adapter) throw new Error(`unknown harness ${harness}`);
  const binary = resolveBinary(adapter, flags.get("command"));
  const version = flags.get("version") ?? cliVersion(adapter, binary);
  const scenarios = scenarioArg === "all" ? SCENARIOS : scenarioArg.split(",");
  for (const scenario of scenarios) {
    if (!SCENARIO_STEPS[scenario])
      throw new Error(`unknown scenario ${scenario}`);
  }
  const outDir = flags.get("out") ?? FIXTURES;
  console.log(`${harness} ${version} via ${binary}`);
  for (const scenario of scenarios) {
    const meta = await recordScenario({
      core,
      adapter,
      harness,
      binary,
      version,
      scenario,
      outDir,
      keepTemp: flags.get("keep-temp") === "true",
    });
    console.log(
      `${scenario}: ${meta.reports.length} reports, states ${meta.expected.states.join(" → ") || "(none)"}${meta.notes.length ? `; ${meta.notes.join("; ")}` : ""}`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
