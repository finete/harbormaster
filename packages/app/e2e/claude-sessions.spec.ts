// Claude Code support (decision #18, R6-R8) end to end, against a fake
// `claude` (fake-claude.ts) standing in through HARBORMASTER_CLAUDE_COMMAND:
// the composer's agent dropdown puts a task on Claude Code; its pane gets
// the session id, per-session hooks (`--settings`) and MCP server
// (`--mcp-config`); OSC 7501 drives the row after the app answers the
// probe; a launched (background) task bypasses permission prompts while an
// interactive pane does not; and a message to the task is delivered through
// the Stop hook (`harbormaster hook inbox --mode follow-up` printing
// `decision: block`).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore, type Task } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { chooseWhere, submitAs } from "./composer";
import {
  controlFakeClaude,
  readFakeClaude,
  waitForFakeClaude,
  writeFakeClaude,
} from "./fake-claude";
import { writeShellPi } from "./fake-pi";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const cliBin = path.join(
  __dirname,
  "..",
  "..",
  "cli",
  "bin",
  "harbormaster.js",
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBE_ANSWER = "1b5d373530313b3f07";

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-claude-"));
  stateDir = path.join(root, "state");
  const claudeConfig = path.join(root, "claude-config");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(claudeConfig, { recursive: true });
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      HARBORMASTER_CLAUDE_COMMAND: writeFakeClaude(root),
      HARBORMASTER_PI_COMMAND: writeShellPi(root),
      // Claude's own files (default model, transcripts) come from here,
      // never from the real ~/.claude.
      CLAUDE_CONFIG_DIR: claudeConfig,
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) mainProcessErrors.push(text);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

async function taskByTitle(title: string): Promise<Task> {
  const core = createCore({ stateDir });
  let found: Task | undefined;
  await expect
    .poll(async () => {
      const columns = await core.commands.listBoard();
      found = columns
        .flatMap((column) => column.groups.flatMap((group) => group.tasks))
        .find((task) => task.title === title);
      return found?.id ?? null;
    })
    .not.toBeNull();
  return found as Task;
}

async function chooseAgent(harness: string): Promise<void> {
  await window.getByTestId("new-task-agent").click();
  await window
    .getByTestId("new-task-agent-menu")
    .locator(`[data-testid="new-task-agent-option"][data-harness="${harness}"]`)
    .click();
  await expect(window.getByTestId("new-task-agent")).toHaveAttribute(
    "data-harness",
    harness,
  );
}

test("an interactive Claude Code pane: agent dropdown, probe answered, 7501 drives the row, no permission bypass", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Claude chat");
  await chooseWhere(window, "none");
  await chooseAgent("claude-code");
  await expect(window.getByTestId("new-task-model")).toContainText(
    "Claude Code",
  );
  await submitAs(window, "start");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  const task = await taskByTitle("Claude chat");
  expect(task.harness).toBe("claude-code");
  const record = await waitForFakeClaude(stateDir, task.id);
  // The app's pty layer answered Claude's OSC 7501 probe.
  expect(record.probeAnswer).toBe(PROBE_ANSWER);
  expect(record.sessionId).toMatch(UUID);
  expect(record.env.HARBORMASTER_SESSION_ID).toBe(record.sessionId);
  // An interactive pane keeps the user's own permission settings (R7).
  expect(record.bypass).toBe(false);
  expect(record.args).not.toContain("--dangerously-skip-permissions");

  const row = window.getByTestId(`sidebar-task-row-${task.id}`);
  await expect(row).toContainText("claude-code");
  await expect(row.getByTestId("sidebar-row-spinner")).toBeVisible({
    timeout: 10_000,
  });
  controlFakeClaude(stateDir, task.id, "blocked");
  await expect(row.getByTestId("sidebar-row-attention-dot")).toBeVisible({
    timeout: 10_000,
  });
});

test("a launched Claude Code child: bypass, hooks + MCP on argv, a parent's message arrives through the Stop hook", async () => {
  // The parent, parked (no pane): only the sender of the message below.
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Claude parent");
  await chooseWhere(window, "none");
  // Explicitly Pi (the composer remembers the last pick).
  await chooseAgent("pi");
  await submitAs(window, "park");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  const parent = await taskByTitle("Claude parent");
  expect(parent.harness).toBe("pi");

  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Claude child");
  await window.getByTestId("new-task-prompt-input").fill("-do the child work");
  await chooseWhere(window, "none");
  await window.getByTestId("new-task-parent-add").click();
  await window
    .getByTestId("new-task-parent-menu")
    .getByTestId("new-task-parent-option")
    .filter({ hasText: "Claude parent" })
    .click();
  // A child defaults to its parent's agent (Pi); pick Claude Code instead.
  await expect(window.getByTestId("new-task-agent")).toHaveAttribute(
    "data-harness",
    "pi",
  );
  await chooseAgent("claude-code");
  // Background runs bypass permission prompts by default, visibly (R7).
  await expect(window.getByTestId("new-task-bypass")).toHaveAttribute(
    "data-bypass",
    "true",
  );
  // With a parent set, the default action is Run in background.
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  const child = await taskByTitle("Claude child");
  expect(child.parentTaskId).toBe(parent.id);
  expect(child.harness).toBe("claude-code");
  expect(child.launch?.bypassPermissions).toBe(true);

  const record = await waitForFakeClaude(stateDir, child.id);
  expect(record.bypass).toBe(true);
  expect(record.sessionId).toMatch(UUID);
  // The prompt follows `--`, so a leading "-" is never parsed as a flag.
  expect(record.prompt?.startsWith("-do the child work")).toBe(true);
  expect(record.args[record.args.indexOf("--") + 1]).toBe(record.prompt);
  // The per-session MCP server: absolute CLI, identity in its env.
  const server = record.mcpConfig?.mcpServers.harbormaster;
  expect(path.isAbsolute(server?.command ?? "")).toBe(true);
  expect(server?.args).toEqual(["mcp"]);
  expect(server?.env.HARBORMASTER_TASK_ID).toBe(child.id);
  expect(server?.env.HARBORMASTER_SESSION_ID).toBe(record.sessionId);
  // The per-session hooks (R6), each running that same absolute CLI.
  const hookCommand = (event: string) =>
    record.settings?.hooks[event]?.[0]?.hooks[0]?.command ?? "";
  expect(hookCommand("PostToolUse")).toMatch(/ hook inbox --mode steer$/);
  expect(hookCommand("Stop")).toMatch(/ hook inbox --mode follow-up$/);
  expect(hookCommand("UserPromptSubmit")).toMatch(
    / hook inbox --mode catch-up$/,
  );
  expect(hookCommand("Stop")).toContain(server?.command ?? "<none>");

  // The parent messages its child (direct route) through the CLI.
  const sent = spawnSync(
    cliBin,
    [
      "send_to_task",
      "--taskId",
      child.id,
      "--message",
      "hello from the parent",
      "--mode",
      "followUp",
    ],
    {
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_TASK_ID: parent.id,
      },
      encoding: "utf8",
    },
  );
  expect(sent.stderr).toBe("");
  expect(sent.status).toBe(0);

  // Claude finishes its turn: the Stop hook claims the inbox and blocks
  // the stop with the message as the reason.
  controlFakeClaude(stateDir, child.id, "stop");
  await expect
    .poll(() => readFakeClaude(stateDir, child.id)?.hooks.length ?? 0, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  const hook = readFakeClaude(stateDir, child.id)?.hooks[0];
  expect(hook?.event).toBe("Stop");
  expect(hook?.exitCode).toBe(0);
  const output = hook?.output as { decision?: string; reason?: string };
  expect(output.decision).toBe("block");
  expect(output.reason).toContain("hello from the parent");
  const core = createCore({ stateDir });
  const messages = await core.commands.listMessages({ taskId: child.id });
  expect(messages.map((message) => message.status)).toContain("delivered");
});
