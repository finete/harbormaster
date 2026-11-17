import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { CURSOR_CONTRACT as C } from "./contracts/cursor";
import { notReplayed } from "./contracts/types";

/** One hook the fake ran, with what it printed. */
export interface FakeCursorHookRun {
  event: string;
  input: Record<string, unknown>;
  output: unknown;
  exitCode: number | null;
}

/** What a {@link writeFakeCursor} process recorded about itself. */
export interface FakeCursorRecord {
  args: string[];
  /** The chat id: new for a fresh chat, the given one on `--resume`. */
  sessionId: string;
  resumed: boolean;
  trust: boolean;
  approveMcps: boolean;
  bypass: boolean;
  model: string | null;
  prompt: string | null;
  pluginDir: string | null;
  /** Hook command per event, from `<plugin dir>/hooks/hooks.json`. */
  hooks: Record<string, string>;
  /** `<plugin dir>/mcp.json`, parsed (null when absent). */
  mcp: Record<string, unknown> | null;
  env: Record<string, string>;
  transcript: string;
  hookRuns: FakeCursorHookRun[];
  /** Each submitted prompt in order (initial, typed, a stop hook's follow-up). */
  prompts: Array<{ text: string; via: "argv" | "typed" | "followup" }>;
  /** Lines typed at its prompt, as submitted. */
  typed: string[];
  /** Turns waiting for a `finish` control command (HM_FAKE_CURSOR_HOLD). */
  held: number;
}

/** Where a task's fake cursor records itself / reads control commands. */
export function fakeCursorPaths(
  stateDir: string,
  taskId: string,
): { record: string; control: string } {
  const dir = path.join(stateDir, "fake-cursor");
  return {
    record: path.join(dir, `${taskId}.json`),
    control: path.join(dir, `${taskId}.ctl`),
  };
}

export function readFakeCursor(
  stateDir: string,
  taskId: string,
): FakeCursorRecord | undefined {
  try {
    return JSON.parse(
      readFileSync(fakeCursorPaths(stateDir, taskId).record, "utf8"),
    ) as FakeCursorRecord;
  } catch {
    return undefined;
  }
}

/** Waits until the task's fake cursor has recorded itself. */
export async function waitForFakeCursor(
  stateDir: string,
  taskId: string,
): Promise<FakeCursorRecord> {
  await expect
    .poll(() => readFakeCursor(stateDir, taskId)?.sessionId ?? null, {
      timeout: 30_000,
    })
    .not.toBeNull();
  return readFakeCursor(stateDir, taskId) as FakeCursorRecord;
}

/** Sends one control command (`finish`, `tool`) to the task's fake cursor. */
export function controlFakeCursor(
  stateDir: string,
  taskId: string,
  command: string,
): void {
  writeFileSync(fakeCursorPaths(stateDir, taskId).control, command);
}

// Every behavior below replays a row of contracts/cursor.ts (checked by
// tests/fake-contract-coverage.test.ts); the rows' strings are inlined
// into the script, so the fake says exactly what the pinned binary says.
const FACTS = {
  version: C.row("cursor.version").facts.output,
  auth: C.row("cursor.auth.required").facts,
  dialogs: C.row("cursor.dialogs.skipped").facts,
  plugin: C.row("cursor.plugin.layout").facts,
  shell: C.row("cursor.hook.command-shell").facts,
  sessionStart: C.row("cursor.hook.session-start").facts,
  submit: C.row("cursor.hook.before-submit-prompt").facts,
  postToolUse: C.row("cursor.hook.post-tool-use").facts,
  stop: C.row("cursor.hook.stop").facts,
  followUp: C.row("cursor.hook.stop-followup").facts,
  resume: C.row("cursor.argv.resume").facts,
  bypass: C.row("cursor.argv.bypass").facts.flag,
  model: C.row("cursor.argv.model").facts.flag,
  models: C.row("cursor.models.list").facts,
  separator: C.row("cursor.prompt.after-dashdash").facts.separator,
  transcript: C.row("cursor.session-file.layout").facts,
  input: C.row("cursor.input.ready").facts,
  quiet: C.row("cursor.status.no-pty-status").facts,
};
notReplayed(
  "cursor.argv.flags",
  "the fake parses the flags the launch uses; --help text is only asserted against the real binary (T3)",
);
notReplayed(
  "cursor.create-chat",
  "Harbormaster never calls create-chat (ids are learned from the hooks); T3 asserts the real subcommand",
);

/**
 * A stand-in `agent` (for `HARBORMASTER_CURSOR_COMMAND`, a node script)
 * replaying contracts/cursor.ts:
 *
 * - `--version`; `--list-models` and `-p` (logged out when
 *   `HM_FAKE_CURSOR_LOGGED_OUT=1`: "Authentication required");
 * - without `--trust` / `--approve-mcps` the dialogs' text, and nothing
 *   else ever happens;
 * - argv: `--plugin-dir <dir>` (hooks from `<dir>/hooks/hooks.json` only,
 *   MCP from `<dir>/mcp.json`), `--resume=<id>` / `--workspace`, `-f`,
 *   `--model`, the prompt after `--`; recorded with the `HARBORMASTER*` env
 *   as JSON in `<HARBORMASTER_STATE_DIR>/fake-cursor/<taskId>.json`;
 * - nothing on the pty (no 7501, no OSC 9); a new chat runs sessionStart;
 * - a submitted prompt (argv, or typed: Enter = "\r", a bracketed paste
 *   keeps its newlines) runs beforeSubmitPrompt, then after ~300 ms (or a
 *   `finish` control command when `HM_FAKE_CURSOR_HOLD=1`) stop with
 *   status completed, `loop_count` and tokens; a `followup_message` runs
 *   as the next turn without beforeSubmitPrompt; the transcript is written
 *   at the first turn's end;
 * - control commands in `<taskId>.ctl`: `finish` ends a held turn, `tool`
 *   runs postToolUse.
 */
export function writeFakeCursor(dir: string): string {
  const file = path.join(dir, "fake-cursor.mjs");
  const script = String.raw`#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const F = ${JSON.stringify(FACTS)};
const args = process.argv.slice(2);
const done = (text, code = 0) => { writeSync(1, text); process.exit(code); };
const loggedOut = process.env.HM_FAKE_CURSOR_LOGGED_OUT === "1";
const authLine = "Error: " + F.auth.message + ". Run 'agent login' first.\n";
if (args[0] === "--version") done(F.version + "\n");
if (args.includes(F.models.args[0])) {
  if (loggedOut) done(authLine, F.auth.listExit);
  done(F.models.header + "\n\n" + F.models.lines.join("\n") + "\n");
}
if (args.includes(F.auth.printArgs[0])) done(loggedOut ? authLine : "OK\n", loggedOut ? F.auth.printExit : 0);
let trust = false, approveMcps = false, bypass = false, model = null, pluginDir = null;
let resumeId = null, workspace = null, prompt = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === F.separator) { prompt = args[i + 1] ?? null; break; }
  if (arg === F.dialogs.trustFlag) trust = true;
  else if (arg === F.dialogs.mcpFlag) approveMcps = true;
  else if (arg === F.bypass) bypass = true;
  else if (arg === F.model) model = args[++i];
  else if (arg === F.plugin.flag) pluginDir = args[++i];
  else if (arg.startsWith(F.resume.flag + "=")) resumeId = arg.slice(F.resume.flag.length + 1);
  else if (arg === F.resume.workspace) workspace = args[++i];
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const hooksFile = pluginDir ? readJson(join(pluginDir, F.plugin.hooksFile)) : null;
const hooks = {};
if (hooksFile && hooksFile.version === F.plugin.hooksVersion) {
  for (const [event, entries] of Object.entries(hooksFile.hooks ?? {})) hooks[event] = entries[0]?.command ?? null;
}
const mcp = pluginDir ? readJson(join(pluginDir, F.plugin.mcpFile)) : null;
const sessionId = resumeId ?? randomUUID();
const taskId = process.env.HARBORMASTER_TASK_ID ?? "no-task";
const dir = join(process.env.HARBORMASTER_STATE_DIR ?? process.cwd(), "fake-cursor");
mkdirSync(dir, { recursive: true });
const recordFile = join(dir, taskId + ".json");
const controlFile = join(dir, taskId + ".ctl");
const cwd = realpathSync(workspace ?? process.cwd());
const data = process.env[F.transcript.dataEnv] || join(homedir(), ".cursor");
const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
const transcript = join(data, F.transcript.projects, slug, F.transcript.dir, sessionId, sessionId + F.transcript.suffix);
const record = {
  args, sessionId, resumed: !!resumeId, trust, approveMcps, bypass, model, prompt, pluginDir, hooks, mcp,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("HARBORMASTER"))),
  transcript, hookRuns: [], prompts: [], typed: [], held: 0,
};
const save = () => writeFileSync(recordFile, JSON.stringify(record, null, 2));
save();
if (!trust) { process.stdout.write(F.dialogs.trustDialog + "\r\n"); setInterval(() => {}, 1000); }
else if (mcp && !approveMcps) { process.stdout.write(F.dialogs.mcpDialog + "\r\n"); setInterval(() => {}, 1000); }
else start();
function runHook(event, input) {
  const command = hooks[event];
  if (!command) return undefined;
  const payload = {
    conversation_id: sessionId, generation_id: input.generation_id ?? sessionId, model: model ?? "auto-smart",
    session_id: sessionId, hook_event_name: event, cursor_version: F.version, workspace_roots: [cwd],
    user_email: "fake@example.invalid",
    transcript_path: existsSync(transcript) ? transcript : null, ...input,
  };
  const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000 });
  let output = result.stdout;
  try { output = JSON.parse(result.stdout); } catch {}
  record.hookRuns.push({ event, input: payload, output, exitCode: result.status });
  save();
  return output;
}
let busy = false;
const queue = [];
let release = null;
function start() {
  if (!resumeId) setTimeout(() => runHook(F.sessionStart.event, { is_background_agent: false }), 150);
  if (prompt) setTimeout(() => submit(prompt, "argv"), 100);
  process.stdout.write("fake cursor ready\r\n");
}
function submit(text, via, loop = 0) {
  if (busy) { queue.push([text, via]); return; }
  busy = true;
  const generation = randomUUID();
  record.prompts.push({ text, via });
  save();
  if (via !== "followup") runHook(F.submit.event, { generation_id: generation, prompt: text, attachments: [] });
  const finish = () => {
    if (!existsSync(transcript)) {
      mkdirSync(join(transcript, ".."), { recursive: true });
      appendFileSync(transcript, JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } }) + "\n");
      appendFileSync(transcript, JSON.stringify({ type: "turn_ended", status: "success" }) + "\n");
    }
    const output = runHook(F.stop.event, {
      generation_id: generation, status: F.stop.statuses[0], [F.followUp.loopKey]: loop,
      input_tokens: 120, output_tokens: 7, cache_read_tokens: 100, cache_write_tokens: 10,
    });
    busy = false;
    const followUp = output && typeof output === "object" ? output[F.followUp.output] : undefined;
    if (typeof followUp === "string" && followUp && loop < 5) { submit(followUp, "followup", loop + 1); return; }
    const next = queue.shift();
    if (next) submit(next[0], next[1]);
  };
  if (process.env.HM_FAKE_CURSOR_HOLD === "1") { record.held += 1; save(); release = finish; }
  else setTimeout(finish, 300);
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  let index;
  while ((index = input.indexOf(F.input.enter)) !== -1) {
    let typed = input.slice(0, index);
    input = input.slice(index + 1);
    typed = typed.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
    if (!typed.trim()) continue;
    record.typed.push(typed.trim());
    save();
    submit(typed.trim(), "typed");
  }
});
setInterval(() => {
  let commands;
  try { commands = readFileSync(controlFile, "utf8"); rmSync(controlFile); } catch { return; }
  for (const command of commands.split("\n").map((entry) => entry.trim())) {
    if (command === "tool") runHook(F.postToolUse.event, { [F.postToolUse.toolKey]: F.postToolUse.shellTool, tool_input: { command: "ls" } });
    else if (command === "finish" && release) { const go = release; release = null; record.held -= 1; save(); go(); }
  }
}, 100);
void F.quiet;
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}
