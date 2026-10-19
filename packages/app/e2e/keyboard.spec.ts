// Keyboard-layer e2e lane: board navigation (arrow keys + Enter), the
// TUI-style single-key shortcuts (n/x/r/s/g/a/Escape; r opens the Await
// picker with review preselected), the pi-home-style key
// legend, kbd hint chips on the Board/New task buttons, and the guard that
// keeps every shortcut out of the way while a dialog is open or the
// terminal is focused (see lib/keyboard-guard.ts, lib/board-selection.ts).
// Real @harbormaster/core against a scratch (repository-less) state dir —
// same no-fixture pattern as e2e/smoke.spec.ts — since every scenario here
// only needs repository-less tasks (Start on a repo-less backlog task
// degrades to a plain move, same as a drag; see core-manager.ts's
// startTask).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

let app: ElectronApplication;
let window: Page;
let stateDir: string;

const mainProcessErrors: string[] = [];

function watchForMainProcessErrors(electronApp: ElectronApplication): void {
  const child = electronApp.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) {
      mainProcessErrors.push(text.trim());
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
}

function assertNoMainProcessErrors(): void {
  expect(
    mainProcessErrors,
    `main process reported uncaught exception(s):\n${mainProcessErrors.join("\n---\n")}`,
  ).toEqual([]);
}

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

async function createBacklogTask(title: string): Promise<void> {
  await window.getByTestId("board-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-title-input").fill(title);
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
}

async function selectedCard(): Promise<Locator> {
  return window.locator('[data-testid^="card-"][data-selected="true"]');
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-keyboard-"));
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
    },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();

  // Three backlog cards, in creation order (board-grouping keeps a single
  // repo-less "scratch" group, task order preserved), so navigation/row
  // movement has more than one card to move across.
  await createBacklogTask("Keyboard Alpha");
  await createBacklogTask("Keyboard Beta");
  await createBacklogTask("Keyboard Gamma");
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test("the key legend renders at the top of the board view", async () => {
  const legend = window.getByTestId("board-key-legend");
  await expect(legend).toBeVisible();
  await expect(legend).toContainText("Open");
  await expect(legend).toContainText("New");
  await expect(legend).toContainText("Done");
  await expect(legend).toContainText("Await (review)");
  // The workflow keys are verbs; no awaiting kind is a key of its own.
  await expect(legend).not.toContainText("Review");
  await expect(legend).toContainText("Start");
  await expect(legend).toContainText("Refresh");
  await expect(legend).toContainText("Archived");
  await expect(legend).toContainText("Navigate");
  await expect(legend).toContainText("Workspace");
});

test("kbd hint chips are visible on the Board and New task buttons", async () => {
  await expect(
    window.getByTestId("board-new-task-button").locator("kbd"),
  ).toBeVisible();
  await window.getByTestId("workspace-button").click();
  await expect(window.getByTestId("board-button").locator("kbd")).toBeVisible();
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
});

test("selection starts on the first card and arrow keys move it", async () => {
  await expect(cardLocator("Keyboard Alpha")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await window.keyboard.press("ArrowDown");
  await expect(cardLocator("Keyboard Beta")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await window.keyboard.press("ArrowDown");
  await expect(cardLocator("Keyboard Gamma")).toHaveAttribute(
    "data-selected",
    "true",
  );

  // Clamped at the bottom of the column.
  await window.keyboard.press("ArrowDown");
  await expect(cardLocator("Keyboard Gamma")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await window.keyboard.press("ArrowUp");
  await expect(cardLocator("Keyboard Beta")).toHaveAttribute(
    "data-selected",
    "true",
  );
});

test("Enter opens the selected task's workspace", async () => {
  const taskId = await cardLocator("Keyboard Beta").getAttribute("data-testid");
  if (!taskId) throw new Error("card missing data-testid");

  await window.keyboard.press("Enter");
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(
    window.getByTestId(taskId.replace("card-", "task-workspace-")),
  ).toBeVisible();

  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
});

test('"n" opens the New Task dialog, and typing inside it does not also trigger single-key shortcuts', async () => {
  await window.keyboard.press("n");
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();

  // Typing a title full of shortcut letters (n/x/r/s/g/a) must only land in
  // the input — none of them should move selection, toggle archived, etc.
  const beforeSelected = await (await selectedCard()).getAttribute(
    "data-testid",
  );
  await window.getByTestId("new-task-title-input").fill("xrsga nav test");
  await expect(window.getByTestId("new-task-title-input")).toHaveValue(
    "xrsga nav test",
  );
  const afterSelected = await (await selectedCard()).getAttribute(
    "data-testid",
  );
  expect(afterSelected).toBe(beforeSelected);

  await window.keyboard.press("Escape");
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
});

test('"x" moves the selected card to Done', async () => {
  // Clamp to the top of the backlog column, then step down to the bottom
  // (Keyboard Gamma) regardless of whatever the previous test left selected.
  await window.keyboard.press("ArrowUp");
  await window.keyboard.press("ArrowUp");
  await window.keyboard.press("ArrowUp");
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("ArrowDown");
  await expect(cardLocator("Keyboard Gamma")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await window.keyboard.press("x");
  await expect(window.getByTestId("column-done-cards")).toContainText(
    "Keyboard Gamma",
  );
  await expect(window.getByTestId("column-backlog-cards")).not.toContainText(
    "Keyboard Gamma",
  );
});

test('"r" opens the Await picker with review preselected; Enter (the fast path) moves the card to Awaiting / Review', async () => {
  // Keyboard Alpha sits at the top of the backlog column: s starts it.
  for (let i = 0; i < 4; i++) await window.keyboard.press("ArrowLeft");
  for (let i = 0; i < 3; i++) await window.keyboard.press("ArrowUp");
  await expect(cardLocator("Keyboard Alpha")).toHaveAttribute(
    "data-selected",
    "true",
  );
  // A backlog card can't await yet: r is inert there.
  await window.keyboard.press("r");
  await expect(window.getByTestId("await-picker")).toHaveCount(0);
  await window.keyboard.press("s");
  await expect(window.getByTestId("column-dev-cards")).toContainText(
    "Keyboard Alpha",
  );

  await window.keyboard.press("r");
  const picker = window.getByTestId("await-picker");
  await expect(picker).toBeVisible();
  await expect(window.getByTestId("await-picker-kind-review")).toBeChecked();
  // Single keys are dead while the picker is open (no stray Done).
  await window.keyboard.press("x");
  await expect(window.getByTestId("column-done-cards")).not.toContainText(
    "Keyboard Alpha",
  );
  await window.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(window.getByTestId("column-awaiting-cards")).toContainText(
    "Keyboard Alpha",
  );
  await expect(
    window
      .getByTestId("column-awaiting-cards")
      .getByTestId("group-primary-label")
      .first(),
  ).toHaveText("Review");
});

test("the Await picker's slack kind shows its permalink field and stores it", async () => {
  // Keyboard Alpha is still selected (now in Awaiting / Review).
  await expect(cardLocator("Keyboard Alpha")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await window.keyboard.press("r");
  await expect(window.getByTestId("await-picker")).toBeVisible();
  await expect(window.getByTestId("await-picker-field-permalink")).toHaveCount(
    0,
  );
  await window.getByTestId("await-picker-kind-slack").check();
  const permalink = window.getByTestId("await-picker-field-permalink");
  await expect(permalink).toBeVisible();
  await permalink.fill("https://acme.slack.com/archives/C1/p2");
  await permalink.press("Enter");
  await expect(window.getByTestId("await-picker")).toHaveCount(0);
  await expect(
    window
      .getByTestId("column-awaiting-cards")
      .getByTestId("group-primary-label")
      .first(),
  ).toHaveText("Slack response");
  const id = (
    await cardLocator("Keyboard Alpha").getAttribute("data-testid")
  )?.replace("card-", "");
  const awaiting = await window.evaluate(
    async (taskId) =>
      (await window.harbormaster.core.getTask(taskId ?? ""))?.awaiting,
    id,
  );
  expect(awaiting).toEqual({
    kind: "slack",
    permalink: "https://acme.slack.com/archives/C1/p2",
  });
});

test('"Escape" returns to the workspace view', async () => {
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("board-view")).toBeHidden();
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
});

test("shortcuts are suppressed while the terminal is focused: the board's single keys (inactive view) and the global Cmd/Ctrl+N", async () => {
  const selectedTestId = await (await selectedCard()).getAttribute(
    "data-testid",
  );
  if (!selectedTestId) throw new Error("no card selected");
  const taskId = selectedTestId.replace("card-", "");

  await window.keyboard.press("Enter"); // open the selected task's workspace
  await window.getByTestId("workspace-view").waitFor({ state: "visible" });
  // Scoped to this task's own workspace: other already-opened tasks
  // (earlier tests) stay mounted-but-hidden, and would otherwise match
  // `terminal-panel` first in DOM order.
  const panel = window
    .getByTestId(`task-workspace-${taskId}`)
    .getByTestId("terminal-panel")
    .first();
  await expect(panel).toBeVisible();
  await panel.click();

  // The board's single-key "n" is inert here anyway (the board isn't the
  // active view); the terminal must still receive it verbatim — it must
  // not, for instance, pop a dialog that'd steal focus from the pty.
  await window.keyboard.type("n");
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  // The global Cmd/Ctrl+N shortcut is the meaningful guard here: focus is
  // inside `.xterm`, so lib/keyboard-guard.ts's isTypingTarget() must block
  // it even though a modifier key is held.
  await window.keyboard.press("Meta+N");
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
  await window.keyboard.press("Control+N");
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
});
