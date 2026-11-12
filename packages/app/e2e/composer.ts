// Shared e2e helpers for the new-task composer (see
// /docs/new-task-composer.md): the Repository chip (Where picker) sits in
// the "Where / How" row under the prompt box, Park in backlog in the split
// submit button's menu, and Parent + the permission switch behind the
// Options chip.
import { expect, type Page } from "@playwright/test";

/**
 * Pick where the draft runs: a repository id, the nth discovered repository
 * (`{ index: 1 }` = the first, matching the old `<select>`'s placeholder
 * offset), or "none" (no folder, the old Chat mode).
 */
export async function chooseWhere(
  page: Page,
  target: string | { index: number } | "none",
): Promise<void> {
  await page.getByTestId("new-task-where").click();
  const menu = page.getByTestId("new-task-where-menu");
  await expect(menu).toBeVisible();
  if (target === "none") {
    await menu.getByTestId("new-task-where-none").click();
  } else if (typeof target === "string") {
    await menu
      .locator(
        `[data-testid="new-task-where-option"][data-where="repo:${target}"]`,
      )
      .first()
      .click();
  } else {
    const options = menu.locator(
      '[data-testid="new-task-where-option"][data-where^="repo:"]',
    );
    // The repository list loads asynchronously after the composer mounts.
    await expect(options.first()).toBeVisible();
    const tokens = [
      ...new Set(
        await options.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-where") ?? ""),
        ),
      ),
    ];
    const token = tokens[target.index - 1];
    if (!token) throw new Error(`no repository at index ${target.index}`);
    await menu
      .locator(`[data-testid="new-task-where-option"][data-where="${token}"]`)
      .first()
      .click();
  }
  await expect(menu).toHaveCount(0);
}

/** Alias kept for readability at call sites that pick a repository. */
export const chooseRepository = chooseWhere;

/** Submit through the split button's menu: "park" (Park in backlog), "start" or "background". */
export async function submitAs(
  page: Page,
  action: "park" | "start" | "background",
): Promise<void> {
  await page.getByTestId("new-task-submit-menu").click();
  await page
    .getByTestId(
      action === "park"
        ? "new-task-submit-backlog"
        : `new-task-submit-${action}`,
    )
    .click();
}

/** Open the Options chip's popover (permission prompts, parent task). */
export async function openOptions(page: Page): Promise<void> {
  await page.getByTestId("new-task-options").click();
  await expect(page.getByTestId("new-task-options-menu")).toBeVisible();
}

/** Make the draft a subtask: Options → Parent task → the first task matching `title` (else the first offered). */
export async function chooseParent(page: Page, title?: string): Promise<void> {
  await openOptions(page);
  await page.getByTestId("new-task-parent-add").click();
  const options = page
    .getByTestId("new-task-parent-menu")
    .getByTestId("new-task-parent-option");
  await (title ? options.filter({ hasText: title }) : options).first().click();
  await expect(page.getByTestId("new-task-options-menu")).toHaveCount(0);
  await expect(page.getByTestId("new-task-parent")).toBeVisible();
}
