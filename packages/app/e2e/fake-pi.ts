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
