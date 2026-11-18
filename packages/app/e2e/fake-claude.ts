import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { CLAUDE_CODE_CONTRACT as C } from "./contracts/claude-code";
import { notReplayed } from "./contracts/types";

/** What a {@link writeFakeClaude} process recorded about itself. */
export interface FakeClaudeRecord {
  args: string[];
  sessionId: string | null;
  bypass: boolean;
  prompt: string | null;
  settings: {
    hooks: Record<
      string,
      Array<{ hooks: Array<{ type: string; command: string }> }>
    >;
  } | null;
  mcpConfig: {
    mcpServers: Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >;
  } | null;
  env: Record<string, string>;
  /** Hex of what the terminal answered to the OSC 7501 probe. */
  probeAnswer: string | null;
  /** Each turn-end / tool hook the fake ran (`stop` / `tool` control commands) and the JSON it printed. */
  hooks: Array<{ event: string; output: unknown; exitCode: number }>;
  /** Each UserPromptSubmit hook run (the initial prompt, typed text). */
  promptHooks: Array<{ event: string; output: unknown; exitCode: number }>;
  /** Each line typed at its prompt, in order. */
  typed: string[];
}

/** Where a task's fake claude records itself / reads control commands. */
export function fakeClaudePaths(
  stateDir: string,
  taskId: string,
): { record: string; control: string } {
  const dir = path.join(stateDir, "fake-claude");
  return {
    record: path.join(dir, `${taskId}.json`),
    control: path.join(dir, `${taskId}.ctl`),
  };
}

export function readFakeClaude(
  stateDir: string,
  taskId: string,
): FakeClaudeRecord | undefined {
  try {
    return JSON.parse(
      readFileSync(fakeClaudePaths(stateDir, taskId).record, "utf8"),
    ) as FakeClaudeRecord;
  } catch {
    return undefined;
  }
}

/** Waits until the task's fake claude has recorded itself (and its probe was answered). */
export async function waitForFakeClaude(
  stateDir: string,
  taskId: string,
): Promise<FakeClaudeRecord> {
  await expect
    .poll(() => readFakeClaude(stateDir, taskId)?.probeAnswer ?? null, {
      timeout: 30_000,
    })
    .not.toBeNull();
  return readFakeClaude(stateDir, taskId) as FakeClaudeRecord;
}

/** Sends one control command (`working`, `blocked`, `idle`, `tool`, `stop`) to the task's fake claude. */
export function controlFakeClaude(
  stateDir: string,
  taskId: string,
  command: string,
): void {
  writeFileSync(fakeClaudePaths(stateDir, taskId).control, command);
}

// Every behavior below replays a row of contracts/claude-code.ts (checked
// by tests/fake-contract-coverage.test.ts); the rows' strings are inlined
// into the script, so the fake says exactly what the pinned binary says.
const FACTS = {
  version: C.row("claude.version").facts.output,
  plugins: C.row("claude.plugin.list-json").facts,
  sessionId: C.row("claude.argv.session-id").facts.flag,
  resume: C.row("claude.argv.resume").facts.flag,
  fork: C.row("claude.argv.fork").facts.flags,
  bypass: C.row("claude.argv.bypass").facts.flag,
  settings: C.row("claude.argv.settings").facts.flag,
  mcp: C.row("claude.argv.mcp-config").facts,
  separator: C.row("claude.prompt.after-dashdash").facts.separator,
  configDir: C.row("claude.env.config-dir").facts,
  probe: C.row("claude.status.probe").facts,
  ready: C.row("claude.status.ready").facts.report,
  turn: C.row("claude.status.turn").facts,
  blocked: C.row("claude.status.blocked").facts.report,
  shell: C.row("claude.hook.command-shell").facts,
  promptSubmit: C.row("claude.hook.user-prompt-submit").facts.event,
  postToolUse: C.row("claude.hook.post-tool-use").facts.event,
  stop: C.row("claude.hook.stop").facts.event,
  stopBlock: C.row("claude.hook.stop-block").facts.decision,
  unknown: C.row("claude.command.unknown").facts.reply,
  skill: C.row("claude.command.skill").facts.file,
  liveReload: C.row("claude.command.skill-live-reload").facts.live,
  liveRemove: C.row("claude.command.skill-live-remove").facts.live,
  review: C.row("claude.review.plannotator-skill").facts,
  transcript: C.row("claude.session-file.layout").facts,
};
notReplayed(
  "claude.trust.folder",
  "the e2e config dir never pre-trusts the scratch/worktree folders, and no T2 spec answers the dialog; the real smoke (T4) answers it",
);
notReplayed(
  "claude.trust.bypass-warning",
  "as claude.trust.folder: no T2 spec answers it; T4 runs with a config that accepted it",
);

/**
 * A stand-in `claude` (for `HARBORMASTER_CLAUDE_COMMAND`, a node script)
 * replaying contracts/claude-code.ts:
 *
 * - `--version`, `plugin list --json` (Plannotator's plugin installed);
 * - argv: `--session-id`, `--resume`, the fork flags, `--settings`,
 *   `--mcp-config` (invalid JSON is a usage error), bypass, the prompt
 *   after `--`; recorded with the `HARBORMASTER*` env as JSON in
 *   `<HARBORMASTER_STATE_DIR>/fake-claude/<taskId>.json`;
 * - the OSC 7501 probe: reports `idle` at its prompt once answered, and
 *   nothing ever if the answer comes too late; an initial prompt starts a
 *   turn (UserPromptSubmit hook, `working`) that ends on a `stop` control;
 * - control commands in `<taskId>.ctl`: `working` / `idle` / `blocked`
 *   report that state; `tool` runs the PostToolUse hook; `stop` runs the
 *   Stop hook (a `block` answer runs one more turn and a second Stop with
 *   `stop_hook_active: true`), then reports `done`;
 * - typed lines: a slash command `/<name>` runs only if the user skill
 *   `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` exists right now (skills
 *   are live; `/plannotator-review` then runs `plannotator review` in this
 *   pty), else prints `Unknown command: /<name>`; other text runs the
 *   UserPromptSubmit hook; the first input writes the transcript
 *   `<configDir>/projects/<slug>/<sessionId>.jsonl`.
 */
export function writeFakeClaude(dir: string): string {
  const file = path.join(dir, "fake-claude.mjs");
  const script = String.raw`#!/usr/bin/env node
// A managed Mac (SentinelOne) SIGKILLs an interpreter + script started with a 943+ char argument.
if (process.argv.slice(2).some((arg) => arg.length >= 943)) process.kill(process.pid, "SIGKILL");
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const F = ${JSON.stringify(FACTS)};
const args = process.argv.slice(2);
const done = (text, code = 0) => { writeSync(1, text); process.exit(code); };
if (args[0] === "--version") done(F.version + "\n");
if (args.join(" ") === F.plugins.args.join(" ")) {
  done(JSON.stringify([{ id: F.plugins.plannotatorId, version: F.plugins.plannotatorVersion, enabled: true }]));
}
const configDir = process.env[F.configDir.env] || join(homedir(), ".claude");
const hasSkill = (name) => existsSync(join(configDir, F.skill.replace("<name>", name)));
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const json = (text) => (text ? JSON.parse(text) : null);
let mcpConfig = null;
try { mcpConfig = json(flag(F.mcp.flag)); } catch { done(F.mcp.invalid + "\n", 1); }
const dash = args.indexOf(F.separator);
const resumed = flag(F.resume);
const taskId = process.env.HARBORMASTER_TASK_ID ?? "no-task";
const dir = join(process.env.HARBORMASTER_STATE_DIR ?? process.cwd(), "fake-claude");
mkdirSync(dir, { recursive: true });
const recordFile = join(dir, taskId + ".json");
const controlFile = join(dir, taskId + ".ctl");
const record = {
  args,
  // A fork and a new session take --session-id; a resume keeps its id.
  sessionId: flag(F.sessionId) ?? (resumed && !resumed.includes("/") ? resumed : null),
  bypass: args.includes(F.bypass),
  prompt: dash === -1 ? null : args[dash + 1],
  settings: json(flag(F.settings)),
  mcpConfig,
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("HARBORMASTER")),
  ),
  probeAnswer: null,
  hooks: [],
  promptHooks: [],
  typed: [],
};
const save = () => writeFileSync(recordFile, JSON.stringify(record, null, 2));
save();
const cwd = realpathSync(process.cwd());
const transcript = record.sessionId
  ? join(configDir, F.transcript.dir, cwd.replace(new RegExp(F.transcript.slugPattern, "g"), "-"), record.sessionId + F.transcript.suffix)
  : null;
const remember = (entry) => {
  if (!transcript) return;
  mkdirSync(join(transcript, ".."), { recursive: true });
  appendFileSync(transcript, JSON.stringify({ ...entry, sessionId: record.sessionId, cwd, timestamp: new Date().toISOString() }) + "\n");
};
let reporting = false;
const report = (body) => { if (reporting) process.stdout.write("\x1b]7501;" + body + "\x07"); };
const runHook = (event, input, into) => {
  const command = record.settings?.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  if (!command) return undefined;
  const result = spawnSync("/bin/sh", ["-c", command], {
    input: JSON.stringify({ session_id: record.sessionId, transcript_path: transcript, cwd, hook_event_name: event, ...input }),
    encoding: "utf8",
  });
  let output = result.stdout;
  try { output = JSON.parse(result.stdout); } catch {}
  into.push({ event, output, exitCode: result.status, stderr: result.stderr, command });
  save();
  return output;
};
const submit = (prompt) => {
  remember({ type: "user", message: { role: "user", content: prompt } });
  runHook(F.promptSubmit, { prompt }, record.promptHooks);
  report(F.turn.working);
};
const stop = () => {
  const output = runHook(F.stop, { stop_hook_active: false }, record.hooks);
  if (output && output.decision === F.stopBlock) {
    // The reason is the next turn's input; then Claude stops again.
    report(F.turn.working);
    runHook(F.stop, { stop_hook_active: true }, record.hooks);
  }
  report(F.turn.done);
};
const runTyped = (typed) => {
  record.typed.push(typed);
  save();
  if (!typed.startsWith("/")) return submit(typed);
  const name = typed.slice(1).split(/\s+/)[0];
  if (!hasSkill(name)) {
    remember({ type: "system", subtype: "informational", content: F.unknown + name });
    process.stdout.write("\x1b[33m●\x1b[39m " + F.unknown + name + "\r\n");
    return;
  }
  remember({ type: "user", message: { role: "user", content: typed } });
  if (typed.split(/\s+/)[0] === F.review.command) {
    spawn(F.review.runs[0], F.review.runs.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
  }
};
process.stdin.setRawMode?.(true);
process.stdin.resume();
let answer = Buffer.alloc(0);
let answered = false;
let line = "";
// No timely answer: Claude never reports in this session.
let gaveUp = false;
const giveUp = setTimeout(() => { gaveUp = true; }, (F.probe.answeredWithinMs + F.probe.givesUpByMs) / 2);
process.stdin.on("data", (chunk) => {
  if (answered) {
    // Raw mode: Enter arrives as "\r".
    line += chunk.toString("utf8");
    let index;
    while ((index = line.search(/[\r\n]/)) !== -1) {
      const typed = line.slice(0, index).trim();
      line = line.slice(index + 1);
      if (typed) runTyped(typed);
    }
    return;
  }
  answer = Buffer.concat([answer, chunk]);
  if (answer.length < 9) return;
  answered = true;
  record.probeAnswer = answer.subarray(0, 9).toString("hex");
  save();
  reporting = !gaveUp;
  clearTimeout(giveUp);
  report(F.ready);
  process.stdout.write("fake claude ready\r\n");
  if (record.prompt) submit(record.prompt);
});
process.stdout.write(F.probe.probe + "\x07");
setInterval(() => {
  let commands;
  try {
    commands = readFileSync(controlFile, "utf8");
    rmSync(controlFile);
  } catch {
    return;
  }
  for (const command of commands.split("\n").map((line) => line.trim())) {
    if (command === "stop") stop();
    else if (command === "tool") {
      runHook(F.postToolUse, { tool_name: "Bash", tool_input: { command: "true" }, tool_response: {} }, record.hooks);
    } else if (command === "working") report(F.turn.working);
    else if (command === "idle") report(F.ready);
    else if (command === "blocked") report(F.blocked);
  }
}, 100);
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}
