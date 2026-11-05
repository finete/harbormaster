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
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  // These smoke tasks have no repository, so parking vs starting only decides
  // the landing column; the suite's assertions expect Backlog.
  await window.getByTestId("new-task-title-input").fill(title);
  await window.getByTestId("new-task-mode-chat").click();
  await window.getByTestId("new-task-submit-backlog").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  // Every create path (board header included) lands in the workspace view
  // now; callers expect the view they started from.
  if (newTaskButtonTestId === "board-new-task-button") {
    await window.getByTestId("board-button").click();
    await expect(window.getByTestId("board-view")).toBeVisible();
  }
}

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-"));
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

test("fresh state dir renders an empty board and an empty sidebar hint", async () => {
  // Fold in the launch/window check: the app must have at least one window
  // with the right title (previously a standalone test).
  expect(app.windows().length).toBeGreaterThan(0);
  await expect(window).toHaveTitle("Harbormaster");
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(window.getByTestId("sidebar-empty-hint")).toBeVisible();
  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]'),
  ).toHaveCount(0);
  await expect(window.getByTestId("workspace-empty-hint")).toBeVisible();
  await expect(window.getByTestId("board-view")).toBeHidden();

  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
  for (const id of ["backlog", "dev", "awaiting", "done"]) {
    await expect(window.getByTestId(`column-${id}`)).toBeVisible();
  }
  await expect(window.locator('[data-testid^="card-"]')).toHaveCount(0);

  await window.getByTestId("workspace-button").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});

test("creating a task shows it on the board; opening it puts it on the rail", async () => {
  await createTask("sidebar-new-task-button", "Task Alpha");

  // Nothing auto-opens anymore: the parked task lives on the board only.
  await window.getByTestId("board-button").click();
  await expect(cardLocator("Task Alpha")).toBeVisible();
  await expect(window.getByTestId("column-backlog-cards")).toContainText(
    "Task Alpha",
  );

  // Opening it from the board is what adds it to the rail (open set).
  await cardLocator("Task Alpha").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]').filter({
      hasText: "Task Alpha",
    }),
  ).toBeVisible();
  await expect(window.getByTestId("sidebar-empty-hint")).toHaveCount(0);
});

test("closing a workspace ends its terminals, drops it off the rail, and reopening from the board starts fresh", async () => {
  // The focused task has a live terminal from the previous test.
  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();

  await window.getByTestId("close-workspace-button").click();
  // Workspace unmounts entirely: no panels, no close button, empty hint only
  // if nothing else is open (this suite has a single task).
  await expect(window.getByTestId("terminal-panel")).toHaveCount(0);
  await expect(window.getByTestId("close-workspace-button")).toHaveCount(0);
  await expect(window.getByTestId("workspace-empty-hint")).toBeVisible();
  // The rail lists open task workspaces only (cmux-style): closing the only
  // open task empties it entirely, even though the task itself is untouched.
  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]'),
  ).toHaveCount(0);

  // Reopening happens from the Board now \u2014 the task dropped off the rail,
  // it didn't disappear from the board.
  await window.getByTestId("board-button").click();
  const card = cardLocator("Task Alpha");
  await expect(card).toBeVisible();
  await card.click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  const reopened = window.getByTestId("terminal-panel").first();
  await expect(reopened).toBeVisible();
  await expect(reopened).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
});

test("terminals survive a board round-trip without respawning", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });

  // Plant a marker in the live shell, round-trip through the board view, and
  // assert the same terminal still shows it: proof the pty was never killed.
  await panel.click();
  await window.keyboard.type("echo berth-$((40+2))");
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("berth-42", { timeout: 10_000 });

  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
  await window.getByTestId("workspace-button").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  await expect(window.getByTestId("terminal-panel").first()).toContainText(
    "berth-42",
  );
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
  await expect(window.getByTestId("board-view")).toBeHidden();
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

// Entering this block: Task Alpha and Task Beta are both open (in the
// rail), Task Beta focused; both still sit in the Backlog column on the
// board. Every test below restores exactly that "both open" rail state by
// the end, since later tests (the repository-group lane) assert a
// scratch-group count of 2.
test("hovering a row reveals a close \u2715; clicking it closes that task's workspace, leaves the task on the board, and moves focus off a task that's gone", async () => {
  const betaRow = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Task Beta" });
  await expect(betaRow).toHaveAttribute("aria-pressed", "true");

  await betaRow.hover();
  await betaRow.getByTestId("sidebar-row-close").click();

  // Gone from the rail...
  await expect(
    window
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Task Beta" }),
  ).toHaveCount(0);
  // ...but closing a row never touches board state: still on the board, in
  // the same column.
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("column-backlog-cards")).toContainText(
    "Task Beta",
  );
  await window.getByTestId("workspace-button").click();

  // Beta was focused when closed: focus moves to the only other open task
  // (App.closeTask), same as Cmd+W already covers for the keyboard path.
  const alphaRow = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Task Alpha" });
  await expect(alphaRow).toHaveAttribute("aria-pressed", "true");

  // Reopen Beta (from its board card) so later tests see both tasks open.
  await window.getByTestId("board-button").click();
  await cardLocator("Task Beta").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});

test("middle-clicking a row closes it too, without touching board state", async () => {
  await window.getByTestId("board-button").click();
  await createTask("board-new-task-button", "Task Gamma");
  const card = cardLocator("Task Gamma");
  await expect(card).toBeVisible();
  await card.click();

  const gammaRow = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Task Gamma" });
  await expect(gammaRow).toBeVisible();

  await gammaRow.click({ button: "middle" });

  await expect(
    window
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Task Gamma" }),
  ).toHaveCount(0);
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("column-backlog-cards")).toContainText(
    "Task Gamma",
  );
  await window.getByTestId("workspace-button").click();
});

test("closing a non-focused row doesn't steal focus from the focused workspace", async () => {
  // Re-focus Beta so this test starts from a known state regardless of
  // whichever task the previous tests left focused.
  const betaRow = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Task Beta" });
  await betaRow.click();
  await expect(betaRow).toHaveAttribute("aria-pressed", "true");

  const alphaRow = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Task Alpha" });
  await alphaRow.hover();
  await alphaRow.getByTestId("sidebar-row-close").click();

  // Alpha is gone from the rail; Beta is still focused and its workspace is
  // still the one showing \u2014 closing a row you're not looking at must not
  // reassign focus.
  await expect(
    window
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Task Alpha" }),
  ).toHaveCount(0);
  await expect(betaRow).toHaveAttribute("aria-pressed", "true");

  // Alpha's board placement is untouched by the close.
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("column-backlog-cards")).toContainText(
    "Task Alpha",
  );

  // Reopen Alpha so the "both open" rail state holds for later tests.
  await cardLocator("Task Alpha").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});

test("the rail lists only opened tasks: a parked backlog task stays off the rail until opened, while still on the board", async () => {
  await window.getByTestId("board-button").click();
  await createTask("board-new-task-button", "Parked Idea");
  await expect(cardLocator("Parked Idea")).toBeVisible();
  await expect(window.getByTestId("column-backlog-cards")).toContainText(
    "Parked Idea",
  );

  await window.getByTestId("workspace-button").click();
  await expect(
    window
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Parked Idea" }),
  ).toHaveCount(0);

  // Both still land in the "both open" state that the rest of this suite
  // expects (Parked Idea deliberately stays unopened and out of scope).
  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]'),
  ).toHaveCount(2);
});

test("dragging a card into awaiting opens the Await picker; cancel keeps the card in place", async () => {
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
  await expect(window.getByTestId("await-picker")).toBeVisible();

  await window.getByTestId("await-picker-cancel").click();
  await expect(window.getByTestId("await-picker")).toHaveCount(0);

  // card stayed in dev; it was never moved.
  await expect(window.getByTestId("column-dev-cards")).toContainText(
    "Task Alpha",
  );
  await expect(window.getByTestId("column-awaiting-cards")).not.toContainText(
    "Task Alpha",
  );
});

test("confirming the Await picker (review preselected) moves the card and shows the Review group header", async () => {
  await dragTo(
    cardLocator("Task Alpha"),
    window.getByTestId("column-awaiting"),
  );
  await expect(window.getByTestId("await-picker")).toBeVisible();

  // Review is the preselected kind; the registry lists all three.
  await expect(window.getByTestId("await-picker-kind-review")).toBeChecked();
  await expect(window.getByTestId("await-picker-kind-slack")).toBeVisible();
  await expect(window.getByTestId("await-picker-kind-deploy")).toBeVisible();
  // A repository-less task has no PR to merge: deploy doesn't apply.
  await expect(window.getByTestId("await-picker-kind-deploy")).toBeDisabled();
  await window.getByTestId("await-picker-confirm").click();
  await expect(window.getByTestId("await-picker")).toHaveCount(0);

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

test("the workspace header keeps the verbs (Await… · Done, no kind names) and Await… opens the same kind picker", async () => {
  const alphaCard = cardLocator("Task Alpha");
  const taskId = (await alphaCard.getAttribute("data-testid"))?.replace(
    "card-",
    "",
  );
  if (!taskId) throw new Error("card missing data-testid");
  await alphaCard.click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  const actions = window
    .getByTestId(`task-workspace-${taskId}`)
    .getByTestId(`task-actions-${taskId}`);
  await expect(actions).toBeVisible();
  await expect(actions.getByTestId(`await-button-${taskId}`)).toContainText(
    "Await…",
  );
  await expect(actions.getByTestId(`to-done-button-${taskId}`)).toBeVisible();
  await expect(actions).not.toContainText("review");
  await expect(actions).not.toContainText("Review");

  await actions.getByTestId(`await-button-${taskId}`).click();
  await expect(window.getByTestId("await-picker")).toBeVisible();
  await expect(window.getByTestId("await-picker-kind-review")).toBeChecked();
  await window.getByTestId("await-picker-cancel").click();
  await expect(window.getByTestId("await-picker")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
});

test("Cmd+B toggles between board and workspace views", async () => {
  // The previous test left the app in the board view.
  // Confirm the board-button / workspace-button pair (formerly separate tests):
  // board visible and workspace hidden while in board view.
  await expect(window.getByTestId("board-view")).toBeVisible();
  await expect(window.getByTestId("workspace-view")).toBeHidden();

  // Workspace button returns to the workspace view; board becomes hidden.
  await window.getByTestId("workspace-button").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("board-view")).toBeHidden();

  // Cmd+B keyboard shortcut toggles between the two views.
  await window.keyboard.press("Meta+B");
  await expect(window.getByTestId("board-view")).toBeVisible();

  await window.keyboard.press("Meta+B");
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});

test("sidebar rows group under a repository header with a state chip per task", async () => {
  // The previous test ended in the workspace view. Both tasks are
  // repository-less, so they share the "scratch" group.
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  const group = window.getByTestId("sidebar-group-scratch");
  await expect(group).toBeVisible();
  await expect(group.getByTestId("sidebar-group-count")).toHaveText("2");

  const alpha = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Task Alpha" });
  const beta = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Task Beta" });
  // Alpha was confirmed into Awaiting / Review above; Beta never left backlog.
  await expect(alpha.getByTestId("state-chip")).toHaveText("Review");
  await expect(beta.getByTestId("state-chip")).toHaveText("Backlog");
  await expect(alpha.getByTestId("sidebar-row-status-dot")).toBeVisible();
  await expect(alpha.getByTestId("sidebar-row-time")).toHaveText(
    /^(now|\d+m)$/,
  );
  await expect(alpha.getByTestId("pr-chip")).toHaveCount(0);

  // Collapsing the group hides its rows; expanding brings them back.
  await window.getByTestId("sidebar-group-toggle-scratch").click();
  await expect(alpha).toHaveCount(0);
  await window.getByTestId("sidebar-group-toggle-scratch").click();
  await expect(alpha).toBeVisible();
});

test("the sidebar search filters rows as you type; Escape and the clear button reset it", async () => {
  const rows = window.locator('[data-testid^="sidebar-task-row-"]');
  const search = window.getByTestId("sidebar-search");
  await expect(rows).toHaveCount(2);

  await search.fill("alpha");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Task Alpha");

  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(2);

  // Repository/group names match too: both tasks live in "scratch".
  await search.fill("SCRATCH");
  await expect(rows).toHaveCount(2);

  await search.fill("no-such-task");
  await expect(rows).toHaveCount(0);
  await expect(window.getByTestId("sidebar-search-empty")).toBeVisible();

  await window.getByTestId("sidebar-search-clear").click();
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(2);
  await expect(window.getByTestId("sidebar-search-empty")).toHaveCount(0);
});

test("collapsing the sidebar hides labels down to a strip of status dots, and expands back", async () => {
  const sidebar = window.getByTestId("sidebar");
  await window.getByTestId("sidebar-collapse").click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]'),
  ).toHaveCount(0);
  await expect(window.getByTestId("sidebar-search")).toHaveCount(0);
  await expect(sidebar).not.toContainText("Task Alpha");
  const dots = window.locator('[data-testid^="sidebar-collapsed-row-"]');
  await expect(dots).toHaveCount(2);
  const box = await sidebar.boundingBox();
  expect(box?.width ?? 0).toBeLessThan(80);
  // Board/new-task stay reachable from the strip.
  await expect(window.getByTestId("board-button")).toBeVisible();
  await expect(window.getByTestId("sidebar-new-task-button")).toBeVisible();

  // Collapsed is persisted (localStorage), so always restore it: later
  // suites share the Electron profile.
  await window.getByTestId("sidebar-collapse").click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await expect(
    window.locator('[data-testid^="sidebar-task-row-"]'),
  ).toHaveCount(2);
});

test("dragging the sidebar's right edge resizes it within bounds; double-click resets", async () => {
  const sidebar = window.getByTestId("sidebar");
  const handle = window.getByTestId("sidebar-resize-handle");
  // Start from the default width regardless of what a prior run persisted.
  await handle.dblclick();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
    .toBe(280);

  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("resize handle not visible");
  const x = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + handleBox.height / 2;

  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + 60, y, { steps: 5 });
  await window.mouse.up();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
    .toBe(340);

  // Way past the max clamps at 480.
  const wideBox = await handle.boundingBox();
  if (!wideBox) throw new Error("resize handle not visible");
  const wx = wideBox.x + wideBox.width / 2;
  await window.mouse.move(wx, y);
  await window.mouse.down();
  await window.mouse.move(wx + 600, y, { steps: 5 });
  await window.mouse.up();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
    .toBe(480);

  await handle.dblclick();
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0))
    .toBe(280);
});
