import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

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
  /** Each hook the fake ran (on a `stop` control command) and the JSON it printed. */
  hooks: Array<{ event: string; output: unknown; exitCode: number }>;
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

/** Sends one control command (`blocked`, `idle`, `working`, `stop`) to the task's fake claude. */
export function controlFakeClaude(
  stateDir: string,
  taskId: string,
  command: string,
): void {
  writeFileSync(fakeClaudePaths(stateDir, taskId).control, command);
}

/**
 * A stand-in `claude` (for `HARBORMASTER_CLAUDE_COMMAND`, a node script)
 * that behaves like Claude Code on the seams Harbormaster relies on:
 *
 * - answers `--version` like Claude Code 2.1.322 (onboarding's detection);
 * - parses `--session-id`, `--settings`, `--mcp-config`,
 *   `--dangerously-skip-permissions` and the prompt after `--` from argv and
 *   records them (plus the `HARBORMASTER*` env) as JSON in
 *   `<HARBORMASTER_STATE_DIR>/fake-claude/<taskId>.json`;
 * - sends the OSC 7501 probe and waits for the terminal's answer (like
 *   Claude, it reports nothing until answered), then reports `working`;
 * - polls `<taskId>.ctl` for commands: `working` / `blocked` / `idle` emit
 *   that 7501 state; `stop` runs the Stop hook command from `--settings`
 *   through `sh -c` with Claude's hook input on stdin and records the JSON
 *   it printed.
 */
export function writeFakeClaude(dir: string): string {
  const file = path.join(dir, "fake-claude.mjs");
  const script = String.raw`#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
// Onboarding's agent detection runs "claude --version".
if (args[0] === "--version") {
  process.stdout.write("2.1.322 (Claude Code)\n");
  process.exit(0);
}
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const json = (text) => (text ? JSON.parse(text) : null);
const dash = args.indexOf("--");
const taskId = process.env.HARBORMASTER_TASK_ID ?? "no-task";
const dir = join(process.env.HARBORMASTER_STATE_DIR ?? process.cwd(), "fake-claude");
mkdirSync(dir, { recursive: true });
const recordFile = join(dir, taskId + ".json");
const controlFile = join(dir, taskId + ".ctl");
const record = {
  args,
  sessionId: flag("--session-id"),
  bypass: args.includes("--dangerously-skip-permissions"),
  prompt: dash === -1 ? null : args[dash + 1],
  settings: json(flag("--settings")),
  mcpConfig: json(flag("--mcp-config")),
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("HARBORMASTER")),
  ),
  probeAnswer: null,
  hooks: [],
};
const save = () => writeFileSync(recordFile, JSON.stringify(record, null, 2));
save();
const report = (body) => process.stdout.write("\x1b]7501;" + body + "\x07");
const runHook = (event, input) => {
  const command = record.settings?.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  if (!command) return;
  const result = spawnSync("/bin/sh", ["-c", command], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  let output = result.stdout;
  try { output = JSON.parse(result.stdout); } catch {}
  record.hooks.push({ event, output, exitCode: result.status, stderr: result.stderr, command });
  save();
};
process.stdin.setRawMode?.(true);
process.stdin.resume();
let answer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  if (record.probeAnswer !== null) return;
  answer = Buffer.concat([answer, chunk]);
  if (answer.length < 9) return;
  record.probeAnswer = answer.subarray(0, 9).toString("hex");
  save();
  report("state=working");
  process.stdout.write("fake claude ready\r\n");
});
process.stdout.write("\x1b]7501;?\x07");
setInterval(() => {
  let commands;
  try {
    commands = readFileSync(controlFile, "utf8");
    rmSync(controlFile);
  } catch {
    return;
  }
  for (const command of commands.split("\n").map((line) => line.trim())) {
    if (command === "stop") {
      runHook("Stop", { hook_event_name: "Stop", stop_hook_active: false });
      report("state=idle");
    } else if (command === "blocked") {
      report("state=blocked:kind=question");
    } else if (command) {
      report("state=" + command);
    }
  }
}, 100);
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}
