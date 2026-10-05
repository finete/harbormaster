// Skeleton smoke lane — proves the electron-vite build boots, the
// workspace/board views render against the real @harbormaster/core command
// API (no mock data, no hand-written state files — everything here is
// seeded by driving the UI), and the dockview/xterm/node-pty wiring is
// alive end-to-end. Not a full test suite; see TASK notes in AGENTS.md /
// docs/design-decisions.md for what's in/out of scope for this skeleton.
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

// Main-process `uncaughtException` is logged (not dialog-boxed, see
// src/main/index.ts) as `[main] uncaughtException: ...` on stderr. Any such
// line during the run is a bug — a destroyed-window/pty race, a thrown IPC
// handler, etc — and must fail the suite, not just the app's UI.
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

// Simulates a dnd-kit drag: real mouse down/move/up over the card and the
// target column, with an intermediate move past the PointerSensor's
// activation distance (4px) before the final move onto the drop target.
async function dragTo(card: Locator, target: Locator): Promise<void> {
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error("drag source/target not visible");

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await window.mouse.move(startX, startY);
  await window.mouse.down();
  // Small step-by-step moves with yields in between: dnd-kit's PointerSensor
  // computes activation distance off real `pointermove` events, and a
  // single multi-step `mouse.move()` call can dispatch them faster than
  // React/dnd-kit's internal state catches up under automation.
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await window.mouse.move(
      startX + (endX - startX) * t,
      startY + (endY - startY) * t,
    );
    await window.waitForTimeout(20);
  }
  await window.waitForTimeout(50);
  await window.mouse.up();
  // Let dnd-kit's dragEnd state settle (releases pointer capture, closes
  // the drag overlay) before the next action interacts with the page.
  await window.waitForTimeout(250);
}

async function createTask(
  newTaskButtonTestId: string,
  title: string,
): Promise<void> {
  await window.getByTestId(newTaskButtonTestId).click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill(title);
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
}

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-"));
  app = await electron.launch({
    args: [mainEntry],
    env: { ...process.env, HARBORMASTER_STATE_DIR: stateDir },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test.afterAll(async () => {
  // electronApp.close() quits the app, which drives app 'before-quit' ->
  // disposeAllSessions() in main/index.ts. If that teardown path ever
  // throws (destroyed-window race, double-dispose, etc) it will have
  // surfaced as a `[main] uncaughtException` line, which the assertion
  // below catches — a clean close() must not leave orphan ptys or trigger
  // the crash dialog this suite is here to guard against.
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

test("app launches and the main window opens", async () => {
  expect(app.windows().length).toBeGreaterThan(0);
  await expect(window).toHaveTitle("Harbormaster");
});

test("fresh state dir renders an empty board and an empty sidebar hint", async () => {
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(window.getByTestId("sidebar-empty-hint")).toBeVisible();
  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]'),
  ).toHaveCount(0);
  await expect(window.getByTestId("workspace-empty-hint")).toBeVisible();
  await expect(window.getByTestId("board-view")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
  for (const id of ["backlog", "dev", "awaiting", "done"]) {
    await expect(window.getByTestId(`column-${id}`)).toBeVisible();
  }
  await expect(window.locator('[data-testid^="card-"]')).toHaveCount(0);

  await window.getByTestId("workspace-button").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});

test("creating a task shows it in the sidebar and the backlog column", async () => {
  await createTask("sidebar-new-task-button", "Task Alpha");

  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]').filter({
      hasText: "Task Alpha",
    }),
  ).toBeVisible();
  await expect(window.getByTestId("sidebar-empty-hint")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await expect(cardLocator("Task Alpha")).toBeVisible();
  await expect(window.getByTestId("column-backlog-cards")).toContainText(
    "Task Alpha",
  );
  await window.getByTestId("workspace-button").click();
});

test("a terminal panel appears for the focused task and receives pty output", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
});

test('"+ terminal" adds a second dockview terminal panel', async () => {
  const before = await window.getByTestId("terminal-panel").count();
  await window.getByTestId("add-terminal-button").click();
  await expect
    .poll(async () => window.getByTestId("terminal-panel").count(), {
      timeout: 10_000,
    })
    .toBeGreaterThan(before);
});

test("the Board button switches to the kanban board with all four columns", async () => {
  await window.getByTestId("board-button").click();

  await expect(window.getByTestId("board-view")).toBeVisible();
  await expect(window.getByTestId("workspace-view")).toHaveCount(0);

  for (const id of ["backlog", "dev", "awaiting", "done"]) {
    await expect(window.getByTestId(`column-${id}`)).toBeVisible();
  }
  await expect(window.locator('[data-testid^="card-"]').first()).toBeVisible();
});

test("the board's Workspace button returns to the workspace view", async () => {
  // the previous test left the app in the board view.
  await expect(window.getByTestId("board-view")).toBeVisible();

  await window.getByTestId("workspace-button").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("board-view")).toHaveCount(0);
});

test("clicking a card returns to the workspace view, focused on that task", async () => {
  await window.getByTestId("board-button").click();
  await createTask("board-new-task-button", "Task Beta");

  const card = cardLocator("Task Beta");
  await expect(card).toBeVisible();
  const cardTestId = await card.getAttribute("data-testid");
  if (!cardTestId) throw new Error("card missing data-testid");
  const taskId = cardTestId.replace("card-", "");

  await card.click();

  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("board-view")).toHaveCount(0);
  await expect(window.getByTestId(`task-workspace-${taskId}`)).toBeVisible();
  await expect(
    window.getByTestId(`sidebar-task-row-${taskId}`),
  ).toHaveAttribute("aria-pressed", "true");

  // the newly-focused task's workspace lazily creates its own terminal, with
  // its own pty, independent of the first task's.
  const panel = window
    .getByTestId(`task-workspace-${taskId}`)
    .getByTestId("terminal-panel")
    .first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
});

test("dragging a card into awaiting opens the reason dialog; cancel keeps the card in place", async () => {
  await window.getByTestId("board-button").click();

  // "Task Alpha" is still in backlog; move it to dev first (allowed
  // transition, no dialog) so dev -> awaiting is a legal move to drag next.
  await dragTo(cardLocator("Task Alpha"), window.getByTestId("column-dev"));
  await expect(window.getByTestId("column-dev-cards")).toContainText(
    "Task Alpha",
  );

  await dragTo(
    cardLocator("Task Alpha"),
    window.getByTestId("column-awaiting"),
  );
  await expect(window.getByTestId("awaiting-reason-dialog")).toBeVisible();

  await window.getByTestId("awaiting-reason-cancel").click();
  await expect(window.getByTestId("awaiting-reason-dialog")).toHaveCount(0);

  // card stayed in dev; it was never moved.
  await expect(window.getByTestId("column-dev-cards")).toContainText(
    "Task Alpha",
  );
  await expect(window.getByTestId("column-awaiting-cards")).not.toContainText(
    "Task Alpha",
  );
});

test("confirming the awaiting reason dialog (Review) moves the card and shows the Review group header", async () => {
  await dragTo(
    cardLocator("Task Alpha"),
    window.getByTestId("column-awaiting"),
  );
  await expect(window.getByTestId("awaiting-reason-dialog")).toBeVisible();

  // "Review" is the default-selected radio option.
  await window.getByTestId("awaiting-reason-confirm").click();
  await expect(window.getByTestId("awaiting-reason-dialog")).toHaveCount(0);

  await expect(window.getByTestId("column-awaiting-cards")).toContainText(
    "Task Alpha",
  );
  await expect(window.getByTestId("column-dev-cards")).not.toContainText(
    "Task Alpha",
  );
  await expect(
    window
      .getByTestId("column-awaiting-cards")
      .getByTestId("group-primary-label")
      .first(),
  ).toHaveText("Review");
});

test("Cmd+B toggles between board and workspace views", async () => {
  // the previous test left the app in the board view; start from a known
  // state so this test doesn't depend on run order.
  await window.getByTestId("workspace-button").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  await window.keyboard.press("Meta+B");
  await expect(window.getByTestId("board-view")).toBeVisible();

  await window.keyboard.press("Meta+B");
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});
