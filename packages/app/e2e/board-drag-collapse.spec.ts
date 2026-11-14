// Board drag mechanics + board group collapse lane.
//
// Drag: dnd-kit's canonical portaled DragOverlay (see Board.tsx/TaskCard.tsx)
// — mid-drag the preview lives under document.body outside the board, the
// in-flow source card is never transformed, and no column scroller grows a
// phantom horizontal scrollbar; the card still lands. Auto-scroll reaches
// both a column's vertical scroller and the board's horizontal one, and a
// release outside every column cancels instead of moving.
//
// Collapse: every board group header is a rail-style toggle (chevron +
// labels + count); collapsing hides the group's cards, arrow navigation
// skips them, and the state survives an app relaunch (localStorage under
// the persisted HARBORMASTER_USER_DATA_DIR profile).
//
// Scratch (repository-less) tasks only, same no-fixture pattern as
// e2e/keyboard.spec.ts: every column then holds a single "scratch" group.
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
import { dragTo, probeDrag } from "./board-gestures";
import { chooseWhere, submitAs } from "./composer";

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

async function launch(): Promise<void> {
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
}

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

async function createBacklogTask(title: string): Promise<void> {
  await window.getByTestId("board-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill(title);
  await chooseWhere(window, "none");
  await submitAs(window, "park");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  // Creating leaves the board for the workspace view; return to it.
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
}

/** Presses the pointer on `card`'s title strip and moves past the 4px activation distance. */
async function beginDrag(card: Locator): Promise<{ x: number; y: number }> {
  const box = await card.boundingBox();
  if (!box) throw new Error("drag source not visible");
  const x = box.x + box.width / 2;
  const y = box.y + 12;
  await window.mouse.move(x, y);
  await window.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await window.mouse.move(x + i * 2, y + i * 2);
    await window.waitForTimeout(20);
  }
  await expect(window.getByTestId("drag-overlay-card")).toHaveCount(1);
  return { x: x + 10, y: y + 10 };
}

async function glide(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await window.mouse.move(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
    );
    await window.waitForTimeout(20);
  }
}

/** Releases the pointer above the board columns (over the toolbar): no column under it, so the drag cancels. */
async function releaseOutsideColumns(from: {
  x: number;
  y: number;
}): Promise<void> {
  const target = { x: from.x, y: 4 };
  await glide(from, target);
  await window.waitForTimeout(50);
  await window.mouse.up();
  await expect(window.getByTestId("drag-overlay-card")).toHaveCount(0);
}

// Enough cards that the backlog column still overflows vertically now that
// the board chrome is a single compact header row (more column height).
const FILLER_COUNT = 16;

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-board-drag-"));
  await launch();
  await createBacklogTask("Drag Mover");
  for (let i = 1; i <= FILLER_COUNT; i++) {
    await createBacklogTask(`Filler ${String(i).padStart(2, "0")}`);
  }
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test("empty columns show a drop hint and column counts match the cards", async () => {
  await expect(window.getByTestId("column-awaiting-empty")).toBeVisible();
  await expect(window.getByTestId("column-done-empty")).toBeVisible();
  await expect(window.getByTestId("column-backlog-empty")).toHaveCount(0);
  await expect(window.getByTestId("column-backlog-count")).toHaveText(
    String(FILLER_COUNT + 1),
  );
});

test("dragging between columns renders a portaled overlay (no in-flow transform, no phantom scrollbar) and the card lands", async () => {
  const card = cardLocator("Drag Mover");
  const taskId = (await card.getAttribute("data-testid"))?.replace("card-", "");
  if (!taskId) throw new Error("card missing data-testid");

  const probe = await dragTo(window, card, window.getByTestId("column-dev"));
  expect(probe.overlayInBody).toBe(true);
  expect(probe.overlayOutsideBoard).toBe(true);
  expect(probe.overlayTaskId).toBe(taskId);
  expect(probe.sourceTransform).toBe("none");
  expect(probe.horizontallyOverflowingColumns).toEqual([]);

  await expect(window.getByTestId("column-dev-cards")).toContainText(
    "Drag Mover",
  );
  await expect(window.getByTestId("column-backlog-cards")).not.toContainText(
    "Drag Mover",
  );
  // The preview is torn down once the drop settles; no duplicate card ids.
  await expect(window.getByTestId("drag-overlay-card")).toHaveCount(0);
  await expect(window.getByTestId(`card-${taskId}`)).toHaveCount(1);
});

test("the target column previews where the card lands, and Escape cancels the drag without leaving the board", async () => {
  const from = await beginDrag(cardLocator("Filler 03"));
  const dev = await window.getByTestId("column-dev").boundingBox();
  if (!dev) throw new Error("dev column not visible");
  await glide(from, { x: dev.x + dev.width / 2, y: dev.y + dev.height / 2 });
  // Scratch task -> lands last in dev's existing "scratch" group.
  await expect(
    window.getByTestId("group-dev-scratch").getByTestId("drop-placeholder-dev"),
  ).toBeVisible();
  // The source column never previews a drop on itself.
  await expect(window.getByTestId("drop-placeholder-backlog")).toHaveCount(0);

  await window.keyboard.press("Escape");
  await expect(window.getByTestId("drag-overlay-card")).toHaveCount(0);
  await expect(window.getByTestId("drop-placeholder-dev")).toHaveCount(0);
  await window.mouse.up();
  // Escape went to dnd-kit's cancel, not the board's "back to workspace".
  await expect(window.getByTestId("board-view")).toBeVisible();
  await expect(window.getByTestId("column-backlog-cards")).toContainText(
    "Filler 03",
  );
  await expect(window.getByTestId("column-dev-cards")).not.toContainText(
    "Filler 03",
  );
});

test("group headers stay pinned while their column scrolls", async () => {
  const scroller = window.getByTestId("column-backlog-cards");
  await scroller.evaluate((el) => {
    el.scrollTop = 240;
  });
  const header = window.getByTestId("group-toggle-backlog-scratch");
  const [scrollerBox, headerBox] = await Promise.all([
    scroller.boundingBox(),
    header.boundingBox(),
  ]);
  if (!scrollerBox || !headerBox) throw new Error("not visible");
  expect(Math.abs(headerBox.y - scrollerBox.y)).toBeLessThanOrEqual(1);
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
});

test("auto-scroll reaches a column's vertical scroller while dragging near its bottom edge", async () => {
  const scroller = window.getByTestId("column-backlog-cards");
  const overflows = await scroller.evaluate(
    (el) => el.scrollHeight > el.clientHeight,
  );
  expect(overflows, "backlog fixture must overflow vertically").toBe(true);
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });

  const box = await scroller.boundingBox();
  if (!box) throw new Error("backlog scroller not visible");
  const from = await beginDrag(cardLocator("Filler 01"));
  const nearBottom = { x: box.x + box.width / 2, y: box.y + box.height - 8 };
  await glide(from, nearBottom);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(0);

  const midDrag = await probeDrag(window, null);
  expect(midDrag.horizontallyOverflowingColumns).toEqual([]);

  // Released above every column: the drag cancels, nothing moves.
  await releaseOutsideColumns(nearBottom);
  await expect(scroller).toContainText("Filler 01");
});

test("auto-scroll reaches the board's horizontal scroller while dragging near its right edge", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(640, 800);
  });
  const board = window.getByTestId("board-columns");
  await expect
    .poll(() => board.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await board.evaluate((el) => {
    el.scrollLeft = 0;
  });

  try {
    const box = await board.boundingBox();
    if (!box) throw new Error("board not visible");
    const from = await beginDrag(cardLocator("Filler 02"));
    const nearRight = { x: box.x + box.width - 8, y: box.y + box.height / 2 };
    await glide(from, nearRight);
    await expect
      .poll(() => board.evaluate((el) => el.scrollLeft), { timeout: 5_000 })
      .toBeGreaterThan(0);
    await releaseOutsideColumns(nearRight);
    await expect(window.getByTestId("column-backlog-cards")).toContainText(
      "Filler 02",
    );
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 800);
    });
    await board.evaluate((el) => {
      el.scrollLeft = 0;
    });
  }
});

test("the board row scrolls horizontally with a horizontal wheel and with shift+wheel", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(640, 800);
  });
  const board = window.getByTestId("board-columns");
  try {
    await expect
      .poll(() => board.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    const box = await board.boundingBox();
    if (!box) throw new Error("board not visible");
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    await board.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await window.mouse.wheel(200, 0);
    await expect
      .poll(() => board.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);

    await board.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await window.keyboard.down("Shift");
    await window.mouse.wheel(0, 200);
    await window.keyboard.up("Shift");
    await expect
      .poll(() => board.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 800);
    });
    await board.evaluate((el) => {
      el.scrollLeft = 0;
    });
  }
});

test("collapsing a board group hides its cards, keeps the count, and arrow navigation skips them", async () => {
  const toggle = window.getByTestId("group-toggle-backlog-scratch");
  const group = window.getByTestId("group-backlog-scratch");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle.getByTestId("group-count")).toHaveText(
    String(FILLER_COUNT),
  );

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(group).toHaveAttribute("data-collapsed", "true");
  await expect(
    window
      .getByTestId("column-backlog-cards")
      .locator('[data-testid^="card-"]'),
  ).toHaveCount(0);
  await expect(toggle.getByTestId("group-count")).toHaveText(
    String(FILLER_COUNT),
  );
  await expect(toggle.getByTestId("group-repo-label")).toHaveText("scratch");
  // The dev column's group is independent of backlog's.
  await expect(window.getByTestId("group-dev-scratch")).toHaveAttribute(
    "data-collapsed",
    "false",
  );

  // Backlog's cards are off screen, so the keyboard grid skips them:
  // selection lands on (and stays on) the only visible card, in dev.
  const mover = cardLocator("Drag Mover");
  await window.keyboard.press("ArrowLeft");
  await expect(mover).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("ArrowLeft");
  await window.keyboard.press("ArrowUp");
  await window.keyboard.press("ArrowDown");
  await expect(mover).toHaveAttribute("data-selected", "true");
  await expect(
    window.locator('[data-testid^="card-"][data-selected="true"]'),
  ).toHaveCount(1);
});

test("the collapsed state survives an app relaunch, and expanding restores the cards", async () => {
  await app.close();
  assertNoMainProcessErrors();
  await launch();

  const toggle = window.getByTestId("group-toggle-backlog-scratch");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle.getByTestId("group-count")).toHaveText(
    String(FILLER_COUNT),
  );
  await expect(
    window
      .getByTestId("column-backlog-cards")
      .locator('[data-testid^="card-"]'),
  ).toHaveCount(0);
  // Fresh board: selection starts on the first *visible* card.
  await expect(cardLocator("Drag Mover")).toHaveAttribute(
    "data-selected",
    "true",
  );

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(cardLocator("Filler 01")).toBeVisible();
  await window.keyboard.press("ArrowLeft");
  await expect(
    window
      .getByTestId("column-backlog-cards")
      .locator('[data-testid^="card-"][data-selected="true"]'),
  ).toHaveCount(1);
});

test("collapsing a column renders the slim rail (chevron, rotated title, honest count, hover tooltip) and unmounts its cards", async () => {
  const collapseButton = window.getByTestId("column-collapse-backlog");
  await expect(collapseButton).toBeVisible();
  await expect(window.getByTestId("column-backlog-count")).toHaveText(
    String(FILLER_COUNT),
  );

  await collapseButton.click();

  const rail = window.getByTestId("column-backlog");
  await expect(window.getByTestId("column-rail-backlog")).toBeVisible();
  await expect(rail).toHaveAttribute(
    "title",
    `Backlog · ${FILLER_COUNT} tasks`,
  );
  // The count badge keeps the same testid as the expanded header's.
  await expect(window.getByTestId("column-backlog-count")).toHaveText(
    String(FILLER_COUNT),
  );
  // Cards container unmounts entirely \u2014 not just visually hidden.
  await expect(window.getByTestId("column-backlog-cards")).toHaveCount(0);
  await expect(
    window.locator('[data-testid^="card-"]').filter({ hasText: "Filler" }),
  ).toHaveCount(0);
});

test("the collapsed column state survives an app relaunch, and clicking the rail expands it back", async () => {
  await app.close();
  assertNoMainProcessErrors();
  await launch();

  await expect(window.getByTestId("column-rail-backlog")).toBeVisible();
  await expect(window.getByTestId("column-backlog-count")).toHaveText(
    String(FILLER_COUNT),
  );
  await expect(window.getByTestId("column-backlog-cards")).toHaveCount(0);

  await window.getByTestId("column-backlog").click();
  await expect(window.getByTestId("column-rail-backlog")).toHaveCount(0);
  await expect(window.getByTestId("column-collapse-backlog")).toBeVisible();
  await expect(cardLocator("Filler 01")).toBeVisible();
});

test("dropping a card onto a collapsed rail peeks it open mid-drag and moves the task, re-collapsing once the drag ends", async () => {
  // "Drag Mover" stays put in Dev for the card-anatomy lane below; move a
  // throwaway filler into Dev first so the rail-drop has a source card that
  // isn't load-bearing for later tests.
  await dragTo(
    window,
    cardLocator("Filler 02"),
    window.getByTestId("column-dev"),
  );
  await expect(window.getByTestId("column-dev-cards")).toContainText(
    "Filler 02",
  );

  await window.getByTestId("column-collapse-backlog").click();
  await expect(window.getByTestId("column-rail-backlog")).toBeVisible();
  await expect(window.getByTestId("column-backlog-count")).toHaveText(
    String(FILLER_COUNT - 1),
  );

  const rail = window.getByTestId("column-backlog");
  const from = await beginDrag(cardLocator("Filler 02"));
  const railBox = await rail.boundingBox();
  if (!railBox) throw new Error("backlog rail not visible");
  await glide(from, {
    x: railBox.x + railBox.width / 2,
    y: railBox.y + railBox.height / 2,
  });

  // Sustained hover (>500ms) over the collapsed rail auto-expands it as a
  // peek so the drop target is visible (Azure DevOps-style), without
  // touching the saved collapsed preference.
  await expect(window.getByTestId("column-backlog-cards")).toBeVisible({
    timeout: 2_000,
  });
  await window.mouse.up();
  await expect(window.getByTestId("drag-overlay-card")).toHaveCount(0);

  // The peek re-collapses to the saved (still-collapsed) preference the
  // instant the drag ends, so the proof the card actually landed is the
  // rail's own honest count \u2014 the cards container never stays mounted
  // long enough for a post-drop assertion to catch it.
  await expect(window.getByTestId("column-rail-backlog")).toBeVisible();
  await expect(window.getByTestId("column-backlog-count")).toHaveText(
    String(FILLER_COUNT),
  );
  await expect(window.getByTestId("column-backlog-cards")).toHaveCount(0);
  // Dev is back to just "Drag Mover".
  await expect(window.getByTestId("column-dev-cards")).not.toContainText(
    "Filler 02",
  );
  await expect(cardLocator("Drag Mover")).toBeVisible();
});

test("arrow navigation skips a collapsed column, crossing straight to the next expanded one", async () => {
  await expect(window.getByTestId("column-rail-backlog")).toBeVisible();
  // Backlog (collapsed) holds every filler; Dev holds only "Drag Mover".
  // Left/right from it must skip straight over the collapsed column: there
  // is nothing beyond it in either direction (Awaiting/Done are empty), so
  // it stays selected rather than landing on a hidden card.
  const mover = cardLocator("Drag Mover");
  await expect(mover).toBeVisible();
  await window.keyboard.press("ArrowLeft");
  await expect(mover).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("ArrowRight");
  await expect(mover).toHaveAttribute("data-selected", "true");
  await expect(
    window.locator('[data-testid^="card-"][data-selected="true"]'),
  ).toHaveCount(1);

  // Restore backlog to expanded so later lanes (card-anatomy below) see
  // its cards again.
  await window.getByTestId("column-backlog").click();
  await expect(window.getByTestId("column-rail-backlog")).toHaveCount(0);
  await expect(cardLocator("Filler 01")).toBeVisible();
});

/** Slot offsets inside one card element (see TaskCard.tsx's fixed skeleton). */
async function cardAnatomy(card: Locator): Promise<{
  titleTop: number;
  timeTop: number;
  timeBottomMinusTitleBottom: number;
}> {
  return card.evaluate((el) => {
    const cardRect = el.getBoundingClientRect();
    const title = el.querySelector('[data-slot="title"]');
    const time = el.querySelector('[data-slot="time"]');
    if (!title || !time) throw new Error("card slots missing");
    const t = title.getBoundingClientRect();
    const m = time.getBoundingClientRect();
    return {
      titleTop: t.top - cardRect.top,
      timeTop: m.top - cardRect.top,
      timeBottomMinusTitleBottom: m.bottom - t.bottom,
    };
  });
}

test("every card variant shares one top-pinned skeleton (title-only vs subline vs drag overlay)", async () => {
  // Give "Drag Mover" a subline: in Awaiting it shows "waiting <duration>".
  await dragTo(
    window,
    cardLocator("Drag Mover"),
    window.getByTestId("column-awaiting"),
  );
  await expect(window.getByTestId("await-picker")).toBeVisible();
  await window.getByTestId("await-picker-confirm").click();
  await expect(window.getByTestId("await-picker")).toHaveCount(0);
  const withSubline = cardLocator("Drag Mover");
  await expect(withSubline.getByTestId("card-waiting-duration")).toBeVisible();
  const titleOnly = cardLocator("Filler 01");

  const a = await cardAnatomy(titleOnly);
  const b = await cardAnatomy(withSubline);
  expect(Math.abs(a.titleTop - b.titleTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.timeTop - b.timeTop)).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(a.timeBottomMinusTitleBottom - b.timeBottomMinusTitleBottom),
  ).toBeLessThanOrEqual(0.5);
  // Every card's subline carries the repo chip ("scratch" here), so a card
  // with no branch/waiting text still has that one slot — and no empty
  // padded badge row: it is exactly as tall as the subline card.
  await expect(titleOnly.getByTestId("card-repo-chip")).toHaveText("scratch");
  await expect(titleOnly.locator('[data-slot="badges"]')).toHaveCount(0);
  await expect(withSubline.locator('[data-slot="badges"]')).toHaveCount(0);
  const [titleOnlyBox, sublineBox] = await Promise.all([
    titleOnly.boundingBox(),
    withSubline.boundingBox(),
  ]);
  expect(
    Math.abs((titleOnlyBox?.height ?? 0) - (sublineBox?.height ?? 0)),
  ).toBeLessThanOrEqual(0.5);

  // The lifted overlay keeps the same internal layout (scaled 1.02).
  const from = await beginDrag(titleOnly);
  const overlay = await cardAnatomy(window.getByTestId("drag-overlay-card"));
  expect(Math.abs(overlay.titleTop - a.titleTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(overlay.timeTop - a.timeTop)).toBeLessThanOrEqual(1);
  await releaseOutsideColumns(from);
});
