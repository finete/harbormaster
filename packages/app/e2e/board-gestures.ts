// Shared board gestures for e2e lanes. Board cards carry no action buttons
// (the workflow verbs live in the workspace header, the board's s/r/x keys,
// and drag-and-drop), so lanes that used to click a card's Start/Done
// button drive the same verbs through these instead. Not a spec file
// (Playwright only collects *.spec.ts).
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Simulates a dnd-kit drag: real pointer down/move/up, grabbing the card by
 * its title strip, in small steps so the activation constraint (4px) and
 * droppable collision detection both see a genuine gesture.
 */
export async function dragTo(
  window: Page,
  card: Locator,
  target: Locator,
): Promise<void> {
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error("drag source/target not visible");
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
  await window.mouse.up();
  await window.waitForTimeout(250);
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
