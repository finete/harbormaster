// Shared board gestures for e2e lanes. Board cards carry no action buttons
// (the workflow verbs live in the workspace header, the board's s/r/x keys,
// and drag-and-drop), so lanes that used to click a card's Start/Done
// button drive the same verbs through these instead. Not a spec file
// (Playwright only collects *.spec.ts).
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * What the board looked like mid-drag, just before the pointer is released
 * (see Board.tsx's portaled DragOverlay): the preview lives directly under
 * `document.body`, outside the board, while the in-flow source card stays
 * untransformed and no column scroller overflows horizontally.
 */
export interface DragProbe {
  /** A `drag-overlay-card` exists in `document.body`… */
  overlayInBody: boolean;
  /** …and is outside the board view (i.e. portaled, never clipped by a column scroller). */
  overlayOutsideBoard: boolean;
  /** The overlay's task id (`data-task-id`). */
  overlayTaskId: string | null;
  /** The in-flow source card's computed `transform` (`"none"` = never moved). */
  sourceTransform: string | null;
  /** Column card scrollers whose content overflows horizontally (phantom scrollbar). */
  horizontallyOverflowingColumns: string[];
}

/**
 * Simulates a dnd-kit drag: real pointer down/move/up, grabbing the card by
 * its title strip, in small steps so the activation constraint (4px) and
 * droppable collision detection both see a genuine gesture. Grab/drop
 * geometry only reads the source card's and target's resting boxes (the
 * source card never moves during a drag — the DragOverlay follows the
 * pointer). Returns a mid-drag `DragProbe` for lanes that assert on it.
 */
export async function dragTo(
  window: Page,
  card: Locator,
  target: Locator,
): Promise<DragProbe> {
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error("drag source/target not visible");
  const sourceTestId = await card.getAttribute("data-testid");
  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + 12;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;
  await window.mouse.move(startX, startY);
  await window.mouse.down();
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
  const probe = await probeDrag(window, sourceTestId);
  await window.mouse.up();
  await window.waitForTimeout(250);
  return probe;
}

/** Snapshot of the mid-drag DOM (see `DragProbe`). */
export async function probeDrag(
  window: Page,
  sourceTestId: string | null,
): Promise<DragProbe> {
  return window.evaluate((sourceId) => {
    const overlay = document.querySelector<HTMLElement>(
      '[data-testid="drag-overlay-card"]',
    );
    const board = document.querySelector('[data-testid="board-view"]');
    const source = sourceId
      ? document.querySelector<HTMLElement>(`[data-testid="${sourceId}"]`)
      : null;
    const overflowing = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="column-"][data-testid$="-cards"]',
      ),
    ]
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => el.dataset.testid ?? "");
    return {
      overlayInBody: !!overlay && document.body.contains(overlay),
      overlayOutsideBoard: !!overlay && !board?.contains(overlay),
      overlayTaskId: overlay?.dataset.taskId ?? null,
      sourceTransform: source ? getComputedStyle(source).transform : null,
      horizontallyOverflowingColumns: overflowing,
    };
  }, sourceTestId);
}

const COLUMNS = ["backlog", "dev", "awaiting", "done"] as const;

/**
 * Keyboard-select one card on the visible board (arrow keys only, like a
 * user would): jump to the top of the left-most non-empty column, step
 * right until the selection is in the card's column, then down to it.
 */
export async function selectCard(window: Page, taskId: string): Promise<void> {
  const card = window.getByTestId(`card-${taskId}`);
  await expect(card).toBeVisible();
  let targetColumn = -1;
  for (const [index, state] of COLUMNS.entries()) {
    const inColumn = window
      .getByTestId(`column-${state}-cards`)
      .locator(`[data-testid="card-${taskId}"]`);
    if ((await inColumn.count()) > 0) targetColumn = index;
  }
  if (targetColumn < 0) throw new Error(`card-${taskId} is in no column`);

  for (let i = 0; i < COLUMNS.length; i++) {
    await window.keyboard.press("ArrowLeft");
  }
  const selectedColumn = async (): Promise<number> => {
    for (const [index, state] of COLUMNS.entries()) {
      const selected = window
        .getByTestId(`column-${state}-cards`)
        .locator('[data-testid^="card-"][data-selected="true"]');
      if ((await selected.count()) > 0) return index;
    }
    return -1;
  };
  for (
    let i = 0;
    i < COLUMNS.length && (await selectedColumn()) < targetColumn;
    i++
  ) {
    await window.keyboard.press("ArrowRight");
  }
  const cardsInColumn = await window
    .getByTestId(`column-${COLUMNS[targetColumn]}-cards`)
    .locator('[data-testid^="card-"]')
    .count();
  for (let i = 0; i < cardsInColumn; i++) {
    await window.keyboard.press("ArrowUp");
  }
  for (
    let i = 0;
    i < cardsInColumn && (await card.getAttribute("data-selected")) !== "true";
    i++
  ) {
    await window.keyboard.press("ArrowDown");
  }
  await expect(card).toHaveAttribute("data-selected", "true");
}
