import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

const PID_FILE = ".fake-pi.pid";

/**
 * A stand-in `pi` (for `HARBORMASTER_PI_COMMAND`) that ignores its
 * arguments and runs a plain shell. A started chat (repository-less task)
 * gets a scratch workspace and so launches the harness in its primary pane;
 * specs that only need *a* live pane use this so the real `pi` never runs.
 *
 * It records its pid in its cwd (`exec` keeps the pid, so it is the pane's
 * pid), which {@link fakePiPid} reads back: a presence record a spec writes
 * on pi's behalf must carry the pane's pid, exactly like the real
 * presence-reporting extension, or the app distrusts it.
 */
export function writeShellPi(dir: string): string {
  const fakePi = path.join(dir, "fake-pi-shell");
  writeFileSync(
    fakePi,
    ["#!/bin/sh", `echo $$ > "$PWD/${PID_FILE}"`, "exec /bin/sh", ""].join(
      "\n",
    ),
  );
  chmodSync(fakePi, 0o755);
  return fakePi;
}

/** The pid of the {@link writeShellPi} pane running in a started chat's scratch directory. */
export async function fakePiPid(
  stateDir: string,
  taskId: string,
): Promise<number> {
  const file = path.join(stateDir, "scratch", taskId, PID_FILE);
  let pid = 0;
  await expect
    .poll(
      () => {
        try {
          pid = Number(readFileSync(file, "utf8").trim());
        } catch {
          pid = 0;
        }
        return pid;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  return pid;
}

/** Control file a {@link writeStatusPi} pane polls: its content is the next OSC 7501 body to emit. */
export const STATUS_CONTROL_FILE = ".fake-pi-status";
/** Where a {@link writeStatusPi} pane records (hex) what the terminal answered to its probe. */
export const PROBE_ANSWER_FILE = ".fake-pi-probe-answer";

/**
 * A stand-in `pi` that speaks the Program Status Protocol (OSC 7501) like a
 * real agent: it sends the feature-detection probe and records the
 * terminal's answer (hex) in {@link PROBE_ANSWER_FILE} (it blocks until
 * answered, so an unanswered probe never reports anything), then emits
 * whatever report body the test writes into {@link STATUS_CONTROL_FILE}
 * (e.g. `state=working`). Pid recorded like {@link writeShellPi}.
 */
export function writeStatusPi(dir: string): string {
  const fakePi = path.join(dir, "fake-pi-status");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      `echo $$ > "$PWD/${PID_FILE}"`,
      "stty raw -echo",
      "printf '\\033]7501;?\\007'",
      `head -c 9 | od -An -tx1 | tr -d ' \\n' > "$PWD/${PROBE_ANSWER_FILE}"`,
      "while :; do",
      `  if [ -f "$PWD/${STATUS_CONTROL_FILE}" ]; then`,
      `    body=$(cat "$PWD/${STATUS_CONTROL_FILE}"); rm -f "$PWD/${STATUS_CONTROL_FILE}"`,
      `    printf '\\033]7501;%s\\007' "$body"`,
      "  fi",
      "  sleep 0.1",
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);
  return fakePi;
}

/**
 * A stand-in `pi` (a node script) that behaves like an agent using the
 * Harbormaster tools: it reports `idle` over OSC 7501, starts the MCP
 * server its launch spec describes (`HARBORMASTER_MCP_SERVER`), lists the
 * tools and calls find_tasks / launch_task / send_to_task / report_status
 * through it, runs the `harbormaster` CLI (`HARBORMASTER_CLI`) once, and
 * writes every result as JSON to `logFile`. Only the first pane that starts
 * runs the script (an atomic `mkdir` lock next to the log); later ones (the
 * launched child) just idle.
 */
export function writeMcpPi(dir: string, logFile: string): string {
  const fakePi = path.join(dir, "fake-pi-mcp.mjs");
  const script = String.raw`#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const LOG = ${JSON.stringify(logFile)};
process.stdout.write("\x1b]7501;state=idle\x07fake pi ready\r\n");
setInterval(() => {}, 1 << 30);
try { mkdirSync(LOG + ".lock"); } catch { await new Promise(() => {}); }
const log = { tools: [], calls: [], cli: null, error: null };
try {
  const config = JSON.parse(process.env.HARBORMASTER_MCP_SERVER ?? "null");
  if (!config) throw new Error("no HARBORMASTER_MCP_SERVER");
  log.config = config;
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...config.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args) => {
    const response = await rpc("tools/call", { name, arguments: args });
    const entry = { name, args, result: response.result, error: response.error };
    log.calls.push(entry);
    return entry;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake-pi", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc("tools/list", {});
  log.tools = listed.result.tools.map((tool) => tool.name);
  await call("find_tasks", { query: "Agent tools parent" });
  const launched = await call("launch_task", {
    relation: "child",
    title: "MCP child",
    prompt: "do the child work",
    repository: "none",
  });
  const childId = /\(([^)]+)\)/.exec(launched.result.content[0].text)[1];
  await call("send_to_task", { taskId: childId, message: "hello from the parent", mode: "steer" });
  // The 7501 idle report above registers presence asynchronously; report_status needs it.
  for (let attempt = 0; attempt < 50; attempt++) {
    const reported = await call("report_status", { status: "done", note: "mcp works" });
    if (!reported.result.isError) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  log.cli = execFileSync(process.env.HARBORMASTER_CLI, ["find_tasks", "--query", "MCP child"], {
    encoding: "utf8",
  });
  child.stdin.end();
} catch (error) {
  log.error = String(error && error.stack ? error.stack : error);
}
writeFileSync(LOG, JSON.stringify(log, null, 2));
`;
  writeFileSync(fakePi, script);
  chmodSync(fakePi, 0o755);
  return fakePi;
}

/**
 * A stand-in `pi` (a node script) for the code review flow
 * (docs/plannotator.md "Transport"): reports `idle` over OSC 7501 and reads
 * its terminal like the real agent's prompt. A typed line (the pty is in
 * cooked mode, so Enter ends it) is appended to `logFile` as
 * `typed "<line>"`; a `/plannotator-review` line runs `plannotator review`
 * (whatever is first on PATH) in the session's own pty and env, so
 * PLANNOTATOR_BROWSER and the ready line behave as with the real agent. It
 * also claims its inbox through the `harbormaster` CLI every 300 ms (like
 * the Pi extension's delivery) and logs each text as `inbox "<text>"`, but
 * never runs a command from it: inbox text is context, not a typed slash
 * command, exactly the gap that made the Review button type instead.
 */
export function writeReviewPi(dir: string, logFile: string): string {
  const fakePi = path.join(dir, "fake-pi-review.mjs");
  const script = String.raw`#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(logFile)};
process.stdout.write("\x1b]7501;state=idle\x07fake review pi ready\r\n");
let line = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  line += chunk;
  let index;
  while ((index = line.search(/[\r\n]/)) !== -1) {
    const typed = line.slice(0, index).trim();
    line = line.slice(index + 1);
    if (!typed) continue;
    appendFileSync(LOG, "typed " + JSON.stringify(typed) + "\n");
    if (typed.startsWith("/plannotator-review")) {
      spawn("plannotator", ["review"], { stdio: ["ignore", "inherit", "inherit"] });
    }
  }
});
const claim = () =>
  execFile(process.env.HARBORMASTER_CLI, ["inbox", "claim"], (error, stdout) => {
    if (!error) {
      for (const message of JSON.parse(stdout).messages ?? []) {
        appendFileSync(LOG, "inbox " + JSON.stringify(message.text) + "\n");
      }
    }
    setTimeout(claim, 300);
  });
claim();
`;
  writeFileSync(fakePi, script);
  chmodSync(fakePi, 0o755);
  return fakePi;
}

/** One assistant turn of a {@link writePiUsageSession} transcript. */
export interface PiUsageTurn {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Pi's own list-price estimate (`usage.cost.total`, USD). */
  cost: number;
}

/** A Pi-format assistant entry carrying `usage` + `cost`, exactly as Pi writes it (docs/costs.md "Harness file facts"). */
export function piUsageEntry(turn: PiUsageTurn, timestamp: string): string {
  const { model, cost, ...buckets } = turn;
  return JSON.stringify({
    type: "message",
    timestamp,
    message: {
      role: "assistant",
      provider: "anthropic",
      model,
      usage: {
        ...buckets,
        totalTokens:
          buckets.input +
          buckets.output +
          buckets.cacheRead +
          buckets.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  });
}

/**
 * Writes the transcript a Pi session leaves behind
 * (`~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`): the session
 * header, a user turn, then one assistant entry with usage + cost per
 * `turns` entry. Append more with {@link piUsageEntry}.
 */
export function writePiUsageSession(
  file: string,
  sessionId: string,
  turns: PiUsageTurn[],
): void {
  const at = (index: number) =>
    new Date(Date.now() - 60_000 + index * 1_000).toISOString();
  const lines = [
    JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp: at(0),
      cwd: path.dirname(file),
    }),
    JSON.stringify({
      type: "message",
      timestamp: at(1),
      message: { role: "user", content: "do the work" },
    }),
    ...turns.map((turn, index) => piUsageEntry(turn, at(index + 2))),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
}
