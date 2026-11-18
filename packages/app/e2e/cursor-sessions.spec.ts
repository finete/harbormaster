// Cursor support (docs/harness-additions.md C1-C9) end to end, against a
// fake `agent` (fake-cursor.ts, replaying contracts/cursor.ts) standing in
// through HARBORMASTER_CURSOR_COMMAND. Every turn of the fake is held until
// the test sends `finish` (HM_FAKE_CURSOR_HOLD), so mid-turn states are
// observable:
// - an interactive Cursor pane: the agent dropdown, the per-session plugin
//   dir the launcher wrote (hooks + MCP), no bypass, presence from the
//   hooks alone (nothing on the pty), the chat id learned from the hooks,
//   and the Review button disabled (no Plannotator integration, C7);
// - a launched Cursor child gets its parent's message through the stop
//   hook's followup_message while busy (C4), and a later one, while it sits
//   idle, typed into its pane (the pty typing fallback; C9: only once the
//   hooks said it is ready).
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
import { chooseParent, chooseWhere, submitAs } from "./composer";
import {
  controlFakeCursor,
  readFakeCursor,
  waitForFakeCursor,
  writeFakeCursor,
} from "./fake-cursor";
import { writeShellPi } from "./fake-pi";
import { launchedBrief } from "./launched-brief";

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

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
const mainProcessErrors: string[] = [];
const deliveryLog: string[] = [];
let watchedId: string | undefined;

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-cursor-"));
  stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      HARBORMASTER_CURSOR_COMMAND: writeFakeCursor(root),
      HARBORMASTER_PI_COMMAND: writeShellPi(root),
      HARBORMASTER_CLI_PATH: cliBin,
      HM_FAKE_CURSOR_HOLD: "1",
      // Cursor's transcripts land here, never in the real ~/.cursor.
      CURSOR_DATA_DIR: path.join(root, "cursor-data"),
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) mainProcessErrors.push(text);
    for (const line of text.split("\n")) {
      if (line.includes("[delivery]") || line.includes("[presence]")) {
        deliveryLog.push(line);
      }
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus && watchedId) {
    const core = createCore({ stateDir });
    const fake = readFakeCursor(stateDir, watchedId);
    console.log(
      `[cursor-sessions] main log:\n${deliveryLog.join("\n")}\n${JSON.stringify(
        {
          prompts: fake?.prompts.map((p) => [p.via, p.text.slice(0, 40)]),
          hooks: fake?.hookRuns.map((r) => [r.event, r.output]),
          held: fake?.held,
          presence: await core.commands.getPresence(watchedId),
          binding: await core.commands.getTaskWorkspace(watchedId),
          messages: await core.commands.listMessages({ taskId: watchedId }),
        },
      )}`,
    );
  }
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

async function boundSession(taskId: string): Promise<string | undefined> {
  return (await createCore({ stateDir }).commands.getTaskWorkspace(taskId))
    ?.sessionId;
}

async function presenceState(taskId: string): Promise<string | undefined> {
  return (await createCore({ stateDir }).commands.getPresence(taskId)).record
    ?.status?.state;
}

/** Waits for the fake's held turn count, then ends one turn. */
async function finishTurn(taskId: string, held = 1): Promise<void> {
  await expect
    .poll(() => readFakeCursor(stateDir, taskId)?.held ?? 0, {
      timeout: 20_000,
    })
    .toBe(held);
  controlFakeCursor(stateDir, taskId, "finish");
  await expect
    .poll(() => readFakeCursor(stateDir, taskId)?.held ?? -1)
    .toBe(held - 1);
}

function sendFromParent(parentId: string, childId: string, text: string) {
  const sent = spawnSync(
    cliBin,
    [
      "send_to_task",
      "--taskId",
      childId,
      "--message",
      text,
      "--mode",
      "followUp",
    ],
    {
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_TASK_ID: parentId,
      },
      encoding: "utf8",
    },
  );
  expect(sent.stderr).toBe("");
  expect(sent.status).toBe(0);
}

test("an interactive Cursor pane: plugin dir with hooks + MCP, no bypass, presence from hooks, Review disabled", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Cursor chat");
  await window.getByTestId("new-task-prompt-input").fill("say hi");
  await chooseWhere(window, "none");
  await chooseAgent("cursor");
  await expect(window.getByTestId("new-task-agent")).toContainText("Cursor");
  await submitAs(window, "start");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  const task = await taskByTitle("Cursor chat");
  watchedId = task.id;
  expect(task.harness).toBe("cursor");
  const record = await waitForFakeCursor(stateDir, task.id);
  expect(record.sessionId).toMatch(UUID);
  // Dialog-skipping flags, then the plugin dir the launcher wrote (C1, C2).
  expect(record.args.slice(0, 4)).toEqual([
    "--trust",
    "--approve-mcps",
    "--plugin-dir",
    path.join(stateDir, "cursor-plugins", task.id),
  ]);
  // An interactive pane keeps the user's own approvals (R7).
  expect(record.bypass).toBe(false);
  for (const [event, name] of [
    ["sessionStart", "session-start"],
    ["beforeSubmitPrompt", "before-submit-prompt"],
    ["postToolUse", "post-tool-use"],
    ["stop", "stop"],
  ]) {
    expect(record.hooks[event]).toMatch(
      new RegExp(` hook cursor --event ${name}$`),
    );
  }
  const mcp = record.mcp as {
    mcpServers: {
      harbormaster: { args: string[]; env: Record<string, string> };
    };
  };
  expect(mcp.mcpServers.harbormaster.args).toEqual(["mcp"]);
  expect(mcp.mcpServers.harbormaster.env.HARBORMASTER_TASK_ID).toBe(task.id);
  // The prompt rides after `--`; a new chat carries no placeholder id.
  expect(record.args.slice(-2)).toEqual(["--", "say hi"]);
  expect(record.env.HARBORMASTER_SESSION_ID).toBeUndefined();
  await expect.poll(() => boundSession(task.id)).toBe(record.sessionId);

  // Nothing on the pty: the hooks drive the row (the turn is held).
  const row = window.getByTestId(`sidebar-task-row-${task.id}`);
  await expect(row.getByTestId("sidebar-row-spinner")).toBeVisible({
    timeout: 10_000,
  });
  await finishTurn(task.id);
  await expect(row.getByTestId("sidebar-row-spinner")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect.poll(() => presenceState(task.id)).toBe("done");

  // No Plannotator integration for Cursor's CLI (C7).
  await window.getByTestId("board-button").click();
  await window.getByTestId(`card-${task.id}`).click();
  const review = window.getByTestId(`review-button-main-${task.id}`);
  await expect(review).toBeDisabled({ timeout: 30_000 });
  await expect(review).toHaveAttribute(
    "title",
    "Plannotator doesn't support Cursor CLI yet",
  );
});

test("a launched Cursor child: bypass, a busy child's follow-up through the stop hook, an idle child's typed into its pane", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Cursor parent");
  await chooseWhere(window, "none");
  await chooseAgent("pi");
  await submitAs(window, "park");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  const parent = await taskByTitle("Cursor parent");

  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Cursor child");
  await window.getByTestId("new-task-prompt-input").fill("-do the child work");
  await chooseWhere(window, "none");
  await chooseParent(window, "Cursor parent");
  await chooseAgent("cursor");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  const child = await taskByTitle("Cursor child");
  watchedId = child.id;
  expect(child.harness).toBe("cursor");
  const record = await waitForFakeCursor(stateDir, child.id);
  expect(record.bypass).toBe(true);
  expect(record.args[record.args.indexOf("--") + 1]).toBe(record.prompt);
  // A launched child's prompt is long (the launch contract is appended):
  // it travels as a file, never as a killable 943+ char argument.
  expect(record.prompt?.length ?? 0).toBeLessThan(400);
  expect(launchedBrief(record.prompt).startsWith("-do the child work")).toBe(
    true,
  );
  await expect.poll(() => boundSession(child.id)).toBe(record.sessionId);
  await expect.poll(() => presenceState(child.id)).toBe("working");

  // Busy: the message waits for the turn's end and rides its stop hook.
  sendFromParent(parent.id, child.id, "hello from the parent");
  await finishTurn(child.id);
  await expect
    .poll(
      () =>
        readFakeCursor(stateDir, child.id)?.prompts.find(
          (prompt) => prompt.via === "followup",
        )?.text ?? "",
      { timeout: 20_000 },
    )
    .toContain("hello from the parent");
  // The follow-up turn fires no beforeSubmitPrompt: still running.
  await expect.poll(() => presenceState(child.id)).toBe("working");
  await finishTurn(child.id);
  await expect.poll(() => presenceState(child.id)).toBe("done");
  const core = createCore({ stateDir });
  await expect
    .poll(async () =>
      (await core.commands.listMessages({ taskId: child.id }))
        .filter((message) => message.targetTaskId === child.id)
        .map((message) => message.status),
    )
    .toEqual(["delivered"]);
  expect(readFakeCursor(stateDir, child.id)?.typed).toEqual([]);

  // Idle at its prompt: main types the message into the pane.
  sendFromParent(parent.id, child.id, "second note from the parent");
  await expect
    .poll(
      () =>
        readFakeCursor(stateDir, child.id)?.typed.find((line) =>
          line.includes("second note from the parent"),
        ) ?? "",
      { timeout: 20_000 },
    )
    .toContain("second note from the parent");
  await expect
    .poll(async () =>
      (await core.commands.listMessages({ taskId: child.id }))
        .filter((message) => message.targetTaskId === child.id)
        .map((message) => message.status),
    )
    .toEqual(["delivered", "delivered"]);
  // Typed as a prompt, it is never repeated as beforeSubmitPrompt context.
  const submits = (readFakeCursor(stateDir, child.id)?.hookRuns ?? []).filter(
    (run) => run.event === "beforeSubmitPrompt",
  );
  expect(submits.at(-1)?.output).toEqual({ continue: true });
  await finishTurn(child.id);
});
