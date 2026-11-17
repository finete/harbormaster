import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { CODEX_CONTRACT as C } from "./contracts/codex";
import { notReplayed } from "./contracts/types";

/** One hook the fake ran, with what it printed. */
export interface FakeCodexHookRun {
  event: string;
  input: Record<string, unknown>;
  output: unknown;
  exitCode: number | null;
}

/** What a {@link writeFakeCodex} process recorded about itself. */
export interface FakeCodexRecord {
  args: string[];
  /** Codex's own id: new for a fresh or forked session, the given one on resume. */
  sessionId: string;
  subcommand: "resume" | "fork" | null;
  bypass: boolean;
  model: string | null;
  prompt: string | null;
  /** Hook command per event, from the `-c hooks.<Event>=…` overrides. */
  hooks: Record<string, string>;
  /** The `-c mcp_servers.harbormaster.*` values, parsed. */
  mcp: Record<string, unknown>;
  /** Every other `-c` override, verbatim. */
  overrides: string[];
  env: Record<string, string>;
  rollout: string;
  hookRuns: FakeCodexHookRun[];
  /** Each submitted prompt (initial, typed, queued), in order. */
  prompts: Array<{ text: string; via: "argv" | "typed" | "queue" }>;
  /** Skills a prompt mentioned that existed (`$<name>`). */
  skills: string[];
  /** Lines typed at its prompt, as submitted. */
  typed: string[];
}

/** Where a task's fake codex records itself / reads control commands. */
export function fakeCodexPaths(
  stateDir: string,
  taskId: string,
): { record: string; control: string } {
  const dir = path.join(stateDir, "fake-codex");
  return {
    record: path.join(dir, `${taskId}.json`),
    control: path.join(dir, `${taskId}.ctl`),
  };
}

export function readFakeCodex(
  stateDir: string,
  taskId: string,
): FakeCodexRecord | undefined {
  try {
    return JSON.parse(
      readFileSync(fakeCodexPaths(stateDir, taskId).record, "utf8"),
    ) as FakeCodexRecord;
  } catch {
    return undefined;
  }
}

/** Waits until the task's fake codex has recorded itself. */
export async function waitForFakeCodex(
  stateDir: string,
  taskId: string,
): Promise<FakeCodexRecord> {
  await expect
    .poll(() => readFakeCodex(stateDir, taskId)?.sessionId ?? null, {
      timeout: 30_000,
    })
    .not.toBeNull();
  return readFakeCodex(stateDir, taskId) as FakeCodexRecord;
}

/** Sends one control command (`working`, `idle`, `blocked`, `tool`) to the task's fake codex. */
export function controlFakeCodex(
  stateDir: string,
  taskId: string,
  command: string,
): void {
  writeFileSync(fakeCodexPaths(stateDir, taskId).control, command);
}

// Every behavior below replays a row of contracts/codex.ts (checked by
// tests/fake-contract-coverage.test.ts); the rows' strings are inlined
// into the script, so the fake says exactly what the pinned binary says.
const FACTS = {
  version: C.row("codex.version").facts.output,
  hooks: C.row("codex.argv.hooks").facts,
  shell: C.row("codex.hook.command-shell").facts,
  sessionStart: C.row("codex.hook.session-start").facts,
  promptSubmit: C.row("codex.hook.user-prompt-submit").facts.event,
  postToolUse: C.row("codex.hook.post-tool-use").facts,
  stop: C.row("codex.hook.stop").facts.event,
  mcp: C.row("codex.argv.mcp").facts.prefix,
  resume: C.row("codex.argv.resume").facts,
  fork: C.row("codex.argv.fork").facts,
  bypass: C.row("codex.argv.bypass").facts,
  model: C.row("codex.argv.model").facts.flag,
  separator: C.row("codex.prompt.after-dashdash").facts.separator,
  ready: C.row("codex.status.no-probe").facts.ready,
  turn: C.row("codex.status.turn").facts,
  blocked: C.row("codex.status.blocked").facts.report,
  queue: C.row("codex.queue").facts,
  skill: C.row("codex.command.skill").facts,
  popup: C.row("codex.command.skill-popup").facts.submitSuffix,
  review: C.row("codex.review.plannotator-skill").facts,
  rollout: C.row("codex.session-file.layout").facts,
  home: C.row("codex.env.home").facts,
};
notReplayed(
  "codex.sandbox.network",
  "the fake runs no sandboxed commands; the launch spec's override is asserted by the core unit test and T3 runs the real sandbox",
);
notReplayed(
  "codex.trust.folder",
  "the e2e CODEX_HOME trusts nothing and no T2 spec answers the dialog, so the fake never shows it; the real smoke (T4) answers it",
);

/**
 * A stand-in `codex` (for `HARBORMASTER_CODEX_COMMAND`, a node script)
 * replaying contracts/codex.ts:
 *
 * - `--version`; `queue --thread <id> --message <text>` (appends to
 *   `<CODEX_HOME>/fake-queue/<id>.jsonl`, which the live session polls);
 * - argv: `--enable hooks --dangerously-bypass-hook-trust`, the `-c
 *   hooks.<Event>` / `mcp_servers.harbormaster.*` overrides, bypass, `-m`,
 *   `resume <id>` / `fork <id>`, the prompt after `--`; recorded with the
 *   `HARBORMASTER*` env as JSON in `<HARBORMASTER_STATE_DIR>/fake-codex/<taskId>.json`;
 * - OSC 7501 without a probe: `idle` at start; a submitted prompt runs
 *   SessionStart (first prompt only), UserPromptSubmit, `working`, and
 *   ~300 ms later Stop, OSC 9 "OK", `done`;
 * - typed lines (raw mode, Enter = "\r"): a bare `$<name>` only completes
 *   (the popup), with a trailing space it submits; queued messages run as
 *   the next turn once idle; `$<name>` mentions of an existing skill
 *   (`<CODEX_HOME>/skills` or `~/.agents/skills`) are recorded, and
 *   `$plannotator-review` runs `plannotator review` in this pty;
 * - control commands in `<taskId>.ctl`: `working` / `idle` / `blocked`
 *   report that state; `tool` runs the PostToolUse hook.
 */
export function writeFakeCodex(dir: string): string {
  const file = path.join(dir, "fake-codex.mjs");
  const script = String.raw`#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const F = ${JSON.stringify(FACTS)};
const args = process.argv.slice(2);
const done = (text, code = 0) => { writeSync(1, text); process.exit(code); };
if (args[0] === "--version") done(F.version + "\n");
const home = process.env[F.home.env] || join(homedir(), F.home.fallback);
const queueFile = (id) => join(home, "fake-queue", id + ".jsonl");
if (args[0] === F.queue.args[0]) {
  const at = (name) => args[args.indexOf(name) + 1];
  const thread = at(F.queue.args[1]);
  const message = at(F.queue.args[3]);
  if (!thread || message === undefined) done("error: --thread and --message are required\n", 2);
  mkdirSync(join(home, "fake-queue"), { recursive: true });
  const id = randomUUID();
  appendFileSync(queueFile(thread), JSON.stringify({ id, message }) + "\n");
  done(F.queue.reply + id + " for thread " + thread + ".\n");
}
// Global options, then an optional subcommand, then "--" and the prompt.
const hooks = {};
const mcp = {};
const overrides = [];
let model = null;
let subcommand = null;
let target = null;
let prompt = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === F.separator) { prompt = args[i + 1] ?? null; break; }
  if (arg === "-c") {
    const value = args[++i];
    if (value.startsWith(F.hooks.overridePrefix)) {
      const event = value.slice(F.hooks.overridePrefix.length, value.indexOf("="));
      hooks[event] = new RegExp(F.hooks.commandPattern).exec(value)?.[1] ?? null;
    } else if (value.startsWith(F.mcp)) {
      const key = value.slice(F.mcp.length, value.indexOf("="));
      mcp[key] = value.slice(value.indexOf("=") + 1);
    } else overrides.push(value);
    continue;
  }
  if (arg === F.model) { model = args[++i]; continue; }
  if (arg === F.resume.subcommand || arg === F.fork.subcommand) {
    subcommand = arg;
    target = args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : null;
  }
}
const resumed = subcommand === F.resume.subcommand && target;
const sessionId = resumed ? target : randomUUID();
const taskId = process.env.HARBORMASTER_TASK_ID ?? "no-task";
const dir = join(process.env.HARBORMASTER_STATE_DIR ?? process.cwd(), "fake-codex");
mkdirSync(dir, { recursive: true });
const recordFile = join(dir, taskId + ".json");
const controlFile = join(dir, taskId + ".ctl");
const cwd = realpathSync(process.cwd());
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const day = join(home, F.rollout.dir, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
const stamp = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + "T" + pad(now.getHours()) + "-" + pad(now.getMinutes()) + "-" + pad(now.getSeconds());
const rollout = join(day, F.rollout.prefix + stamp + "-" + sessionId + F.rollout.suffix);
mkdirSync(day, { recursive: true });
const line = (type, payload) => appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n");
if (!existsSync(rollout)) {
  line("session_meta", { id: sessionId, cwd, ...(subcommand === F.fork.subcommand ? { [F.fork.metaKey]: target } : {}) });
}
const record = {
  args,
  sessionId,
  subcommand,
  bypass: args.includes(F.bypass.flag),
  model,
  prompt,
  hooks,
  mcp,
  overrides,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("HARBORMASTER"))),
  rollout,
  hookRuns: [],
  prompts: [],
  skills: [],
  typed: [],
};
const save = () => writeFileSync(recordFile, JSON.stringify(record, null, 2));
save();
const report = (body) => process.stdout.write("\x1b]7501;" + body + "\x07");
const permissionMode = record.bypass ? F.bypass.permissionMode : F.bypass.defaultMode;
let turnId = null;
const runHook = (event, input) => {
  const command = hooks[event];
  if (!command) return undefined;
  const payload = {
    session_id: sessionId, transcript_path: rollout, cwd, hook_event_name: event,
    model: model ?? "fake-model", permission_mode: permissionMode,
    ...(turnId ? { turn_id: turnId } : {}), ...input,
  };
  const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000 });
  let output = result.stdout;
  try { output = JSON.parse(result.stdout); } catch {}
  record.hookRuns.push({ event, input: payload, output, exitCode: result.status });
  save();
  return output;
};
const skillExists = (name) =>
  existsSync(join(home, F.skill.file.replace("<name>", name))) ||
  existsSync(join(homedir(), F.skill.agentsDir, name, "SKILL.md"));
let started = false;
let busy = false;
const submit = (text, via) => {
  busy = true;
  if (!started) {
    started = true;
    runHook(F.sessionStart.event, { source: resumed ? "resume" : F.sessionStart.newSource });
  }
  turnId = randomUUID();
  record.prompts.push({ text, via });
  save();
  runHook(F.promptSubmit, { prompt: text });
  report(F.turn.working);
  for (const match of text.matchAll(/\$([A-Za-z0-9_-]+)/g)) {
    const name = match[1];
    if (!skillExists(name)) continue;
    record.skills.push(name);
    save();
    if (F.skill.mention + name === F.review.command) {
      spawn(F.review.runs[0], F.review.runs.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
    }
  }
  setTimeout(() => {
    line("token_usage_record", { thread_id: sessionId, turn_id: turnId, usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } });
    runHook(F.stop, { stop_hook_active: false, last_assistant_message: "OK" });
    process.stdout.write(F.turn.osc9 + "OK\x07");
    report(F.turn.done);
    busy = false;
  }, 300);
};
if (prompt) setTimeout(() => submit(prompt, "argv"), 50);
process.stdin.setRawMode?.(true);
process.stdin.resume();
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  let index;
  while ((index = input.search(/[\r\n]/)) !== -1) {
    const typed = input.slice(0, index);
    input = input.slice(index + 1);
    // A bare skill name: Enter completes it in the popup, nothing submits.
    if (/^\$[A-Za-z0-9_-]+$/.test(typed)) { input = typed + F.popup + input; break; }
    if (!typed.trim()) continue;
    record.typed.push(typed.trim());
    save();
    submit(typed.trim(), "typed");
  }
});
report(F.ready);
process.stdout.write("fake codex ready\r\n");
setInterval(() => {
  if (!busy) {
    let queued = "";
    try { queued = readFileSync(queueFile(sessionId), "utf8"); rmSync(queueFile(sessionId)); } catch {}
    const next = queued.split("\n").filter(Boolean).map((entry) => JSON.parse(entry));
    if (next.length > 0) submit(next[0].message, "queue");
    for (const rest of next.slice(1)) appendFileSync(queueFile(sessionId), JSON.stringify(rest) + "\n");
  }
  let commands;
  try {
    commands = readFileSync(controlFile, "utf8");
    rmSync(controlFile);
  } catch {
    return;
  }
  for (const command of commands.split("\n").map((entry) => entry.trim())) {
    if (command === "tool") runHook(F.postToolUse.event, { tool_name: F.postToolUse.toolName, tool_input: { cmd: "true" } });
    else if (command === "working") report(F.turn.working);
    else if (command === "idle") report(F.ready);
    else if (command === "blocked") report(F.blocked);
  }
}, 100);
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}
