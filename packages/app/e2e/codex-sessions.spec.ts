// Codex support (docs/harness-additions.md X1-X11) end to end, against a
// fake `codex` (fake-codex.ts, replaying contracts/codex.ts) standing in
// through HARBORMASTER_CODEX_COMMAND, with its own CODEX_HOME:
// - an interactive Codex pane: the agent dropdown, per-session hooks + MCP
//   as `-c` overrides, no permission bypass, 7501 (no probe) driving the
//   row, the session id learned from SessionStart;
// - a launched Codex child receives its parent's message while idle via
//   `codex queue` (run by main), confirmed by the turn it starts and never
//   repeated as hook context;
// - the Review button hands `$plannotator-review` to the idle agent the
//   same way, and Plannotator opens in the review tab.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  controlFakeCodex,
  readFakeCodex,
  waitForFakeCodex,
  writeFakeCodex,
} from "./fake-codex";
import { writeShellPi } from "./fake-pi";
import { writeFakeOpen, writeFakePlannotator } from "./fake-plannotator";

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
let codexHome: string;
const mainProcessErrors: string[] = [];
/** Main's `[delivery]` log lines, for a failing assertion's message. */
const deliveryLog: string[] = [];
let childId: string | undefined;

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-codex-"));
  stateDir = path.join(root, "state");
  codexHome = path.join(root, "codex-home");
  mkdirSync(stateDir, { recursive: true });
  // Plannotator's Codex skill (review support's codex-skill piece).
  const skill = path.join(codexHome, "skills", "plannotator-review");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: plannotator-review\n---\n",
  );
  const openBin = path.join(root, "open-bin");
  writeFakeOpen(openBin, path.join(root, "system-open.log"));
  const fakeBin = path.join(root, "fake-bin");
  writeFakePlannotator(fakeBin);
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      PATH: [openBin, fakeBin, process.env.PATH].join(path.delimiter),
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      HARBORMASTER_CODEX_COMMAND: writeFakeCodex(root),
      HARBORMASTER_PI_COMMAND: writeShellPi(root),
      HARBORMASTER_CLI_PATH: cliBin,
      // Codex's own files (models, rollouts, skills, the queue) come from
      // here, never from the real ~/.codex.
      CODEX_HOME: codexHome,
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) mainProcessErrors.push(text);
    for (const line of text.split("\n")) {
      if (line.includes("[delivery]")) deliveryLog.push(line);
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log(
      `[codex-sessions] main delivery log:\n${deliveryLog.join("\n")}`,
    );
    const core = createCore({ stateDir });
    const id = childId ?? "";
    const fake = readFakeCodex(stateDir, id);
    console.log(
      `[codex-sessions] child: ${JSON.stringify({
        prompts: fake?.prompts.map((p) => [p.via, p.text.slice(0, 40)]),
        hooks: fake?.hookRuns.map((r) => [r.event, r.output]),
        presence: await core.commands.getPresence(id),
        binding: await core.commands.getTaskWorkspace(id),
        messages: await core.commands.listMessages({ taskId: id }),
      })}`,
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

/** The session id core bound the task to (learned from SessionStart, X3). */
async function boundSession(taskId: string): Promise<string | undefined> {
  return (await createCore({ stateDir }).commands.getTaskWorkspace(taskId))
    ?.sessionId;
}

test("an interactive Codex pane: hooks + MCP as -c overrides, no bypass, 7501 without a probe, Review queues $plannotator-review", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Codex chat");
  await window.getByTestId("new-task-prompt-input").fill("say hi");
  await chooseWhere(window, "none");
  await chooseAgent("codex");
  await expect(window.getByTestId("new-task-agent")).toContainText("Codex");
  await submitAs(window, "start");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  const task = await taskByTitle("Codex chat");
  expect(task.harness).toBe("codex");
  const record = await waitForFakeCodex(stateDir, task.id);
  expect(record.sessionId).toMatch(UUID);
  // An interactive pane keeps the user's own approvals (R7).
  expect(record.bypass).toBe(false);
  // Hooks per session, each running the absolute CLI (X1).
  for (const [event, name] of [
    ["SessionStart", "session-start"],
    ["UserPromptSubmit", "user-prompt-submit"],
    ["PostToolUse", "post-tool-use"],
    ["Stop", "stop"],
  ]) {
    expect(record.hooks[event]).toMatch(
      new RegExp(` hook codex --event ${name}$`),
    );
  }
  expect(record.args.slice(0, 3)).toEqual([
    "--enable",
    "hooks",
    "--dangerously-bypass-hook-trust",
  ]);
  expect(record.mcp.args).toBe('["mcp"]');
  expect(record.mcp.env).toContain(`HARBORMASTER_TASK_ID="${task.id}"`);
  expect(record.overrides).toContain('tui.notification_method="osc9"');
  // A new session never carries a placeholder id; SessionStart reports
  // Codex's own and core binds the task to it.
  expect(record.env.HARBORMASTER_SESSION_ID).toBeUndefined();
  await expect.poll(() => boundSession(task.id)).toBe(record.sessionId);

  // 7501 drives the row (no probe ever answered).
  const row = window.getByTestId(`sidebar-task-row-${task.id}`);
  controlFakeCodex(stateDir, task.id, "working");
  await expect(row.getByTestId("sidebar-row-spinner")).toBeVisible({
    timeout: 10_000,
  });
  controlFakeCodex(stateDir, task.id, "idle");
  await expect(row.getByTestId("sidebar-row-spinner")).toHaveCount(0, {
    timeout: 10_000,
  });

  // Review: Plannotator ready (binary + the codex skill); the idle agent
  // gets `$plannotator-review` through `codex queue`, never as keystrokes.
  await window.getByTestId("board-button").click();
  await window.getByTestId(`card-${task.id}`).click();
  const review = window.getByTestId(`review-button-main-${task.id}`);
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  await expect
    .poll(() => readFakeCodex(stateDir, task.id)?.prompts ?? [])
    .toContainEqual({ text: "$plannotator-review", via: "queue" });
  await expect
    .poll(() => readFakeCodex(stateDir, task.id)?.skills ?? [])
    .toContain("plannotator-review");
  expect(readFakeCodex(stateDir, task.id)?.typed).toEqual([]);
  const workspace = window.getByTestId(`task-workspace-${task.id}`);
  await expect(workspace.getByTestId("url-pane-frame")).toBeVisible({
    timeout: 30_000,
  });
});

test("a launched Codex child: bypass, prompt after --, and a parent's message reaches it idle via codex queue", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Codex parent");
  await chooseWhere(window, "none");
  await chooseAgent("pi");
  await submitAs(window, "park");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  const parent = await taskByTitle("Codex parent");

  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Codex child");
  await window.getByTestId("new-task-prompt-input").fill("-do the child work");
  await chooseWhere(window, "none");
  await chooseParent(window, "Codex parent");
  await chooseAgent("codex");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  const child = await taskByTitle("Codex child");
  childId = child.id;
  expect(child.harness).toBe("codex");
  const record = await waitForFakeCodex(stateDir, child.id);
  expect(record.bypass).toBe(true);
  // The prompt follows `--` (a leading "-" stays text) and ran as a turn.
  expect(record.args[record.args.indexOf("--") + 1]).toBe(record.prompt);
  expect(record.prompt?.startsWith("-do the child work")).toBe(true);
  // The first turn's SessionStart bound the task; wait until that turn is
  // over (its Stop hook ran), so the message below finds the child idle
  // rather than riding the first prompt's catch-up hook.
  await expect.poll(() => boundSession(child.id)).toBe(record.sessionId);
  await expect
    .poll(() =>
      readFakeCodex(stateDir, child.id)?.hookRuns.some(
        (run) => run.event === "Stop",
      ),
    )
    .toBe(true);

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

  // Main ran `codex queue`: the idle child runs it as its next prompt.
  await expect
    .poll(
      () =>
        readFakeCodex(stateDir, child.id)?.prompts.find(
          (prompt) => prompt.via === "queue",
        )?.text ?? "",
      { timeout: 20_000 },
    )
    .toContain("hello from the parent");
  expect(readFakeCodex(stateDir, child.id)?.typed).toEqual([]);
  // Its UserPromptSubmit hook settled the message without repeating it.
  await expect
    .poll(
      () =>
        readFakeCodex(stateDir, child.id)?.hookRuns.find(
          (run) =>
            run.event === "UserPromptSubmit" &&
            String(run.input.prompt).includes("hello from the parent"),
        )?.output,
    )
    .toEqual({});
  const core = createCore({ stateDir });
  await expect
    .poll(async () =>
      (await core.commands.listMessages({ taskId: child.id }))
        .filter((message) => message.targetTaskId === child.id)
        .map((message) => message.status),
    )
    .toEqual(["delivered"]);
});
