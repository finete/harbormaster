// The tool catalog's integration seam (decision #18): an agent session
// launched by the app reaches core through `harbormaster mcp` (the
// per-session MCP server the launch spec hands Pi) and the `harbormaster`
// CLI, both over the app's local socket; with the app down the CLI says
// "Harbormaster is not running". The agent is a fake (a node script, see
// fake-pi.ts `writeMcpPi`) that speaks MCP over stdio like Pi would.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { chooseWhere } from "./composer";
import { writeMcpPi } from "./fake-pi";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const cliBin = path.join(
  __dirname,
  "..",
  "..",
  "cli",
  "bin",
  "harbormaster.js",
);

interface McpLog {
  tools: string[];
  calls: Array<{
    name: string;
    result?: { content: Array<{ text: string }>; isError?: boolean };
  }>;
  cli: string | null;
  error: string | null;
  config?: { command: string; args: string[]; env: Record<string, string> };
}

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
let logFile: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-tools-"));
  stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  logFile = path.join(root, "mcp-log.json");
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      HARBORMASTER_PI_COMMAND: writeMcpPi(root, logFile),
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
  rmSync(root, { recursive: true, force: true });
});

function readLog(): McpLog | undefined {
  try {
    return JSON.parse(readFileSync(logFile, "utf8")) as McpLog;
  } catch {
    return undefined;
  }
}

test("a task session calls the catalog through MCP and the CLI; the CLI reports a stopped app", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Agent tools parent");
  await chooseWhere(window, "none");
  await window.getByTestId("new-task-submit").click();
  const row = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Agent tools parent" });
  await expect(row).toBeVisible();
  const parentId = (await row.getAttribute("data-testid"))?.replace(
    "sidebar-task-row-",
    "",
  );
  if (!parentId) throw new Error("no task id");

  await expect.poll(readLog, { timeout: 30_000 }).toBeDefined();
  const log = readLog() as McpLog;
  expect(log.error).toBeNull();
  // The per-session MCP server: the absolute CLI path, identity in its env.
  expect(path.isAbsolute(log.config?.command ?? "")).toBe(true);
  expect(log.config?.args).toEqual(["mcp"]);
  expect(log.config?.env.HARBORMASTER_TASK_ID).toBe(parentId);
  expect(log.tools).toEqual([
    "report_status",
    "launch_task",
    "subtask_status",
    "find_tasks",
    "send_to_task",
    "inbox_claim",
  ]);
  const byName = (name: string) =>
    log.calls.filter((call) => call.name === name).at(-1)?.result;
  expect(byName("find_tasks")?.content[0]?.text).toContain(
    `"Agent tools parent" (${parentId})`,
  );
  expect(byName("find_tasks")?.content[0]?.text).toContain("self");
  expect(byName("launch_task")?.content[0]?.text).toContain(
    'Launched "MCP child"',
  );
  expect(byName("send_to_task")?.isError).toBeFalsy();
  expect(byName("report_status")?.content[0]?.text).toBe(
    "Recorded done: mcp works",
  );
  expect(log.cli).toContain('"MCP child"');

  // Core saw it all, attributed to the calling task.
  const core = createCore({ stateDir });
  const children = await core.commands.listChildren(parentId);
  expect(children.map((task) => task.title)).toEqual(["MCP child"]);
  const messages = await core.commands.listMessages({ taskId: parentId });
  expect(messages.map((message) => message.route)).toContain("parent-to-child");
  await expect(row.getByTestId("sidebar-row-outcome-line")).toContainText(
    "mcp works",
    { timeout: 10_000 },
  );

  await app.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  const down = spawnSync(cliBin, ["find_tasks", "--query", "x"], {
    env: { ...process.env, HARBORMASTER_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  expect(down.status).toBe(2);
  expect(down.stderr).toBe("Harbormaster is not running\n");
});
