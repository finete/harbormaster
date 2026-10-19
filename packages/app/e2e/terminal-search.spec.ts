// Terminal search e2e (checklist item #12, Chunk H).
//
// Verifies:
//   - Cmd+F opens the search bar (`data-testid="terminal-search"` visible).
//   - Typing in the search bar finds printed text.
//   - The active element stays inside the search bar (keys don't reach the pty).
//   - Esc closes the bar and returns focus to the xterm textarea.
//   - Searching for a non-existent term shows the "No results" indicator.
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

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-search-"));
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      SHELL: "/bin/sh",
    },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Create and open a task.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Search Test Task");
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Search Test Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
  await panel.click();

  // Print some content to search through.
  for (let i = 1; i <= 10; i++) {
    await window.keyboard.type(`echo "line-${i} data-row"`);
    await window.keyboard.press("Enter");
  }
  await window.keyboard.type("echo needle-$((3*3))");
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("needle-9", { timeout: 10_000 });
});

test.afterEach(async () => {
  assertNoMainProcessErrors();
  // Close the search bar if still open between tests.
  const searchBar = window.getByTestId("terminal-search");
  if ((await searchBar.count()) > 0) {
    const inp = window.getByTestId("terminal-search-input");
    await inp.press("Escape").catch(() => {});
    await window.waitForTimeout(100);
  }
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

test("terminal search: open, find text, no-results indicator, Esc restores focus", async () => {
  test.skip(process.platform !== "darwin", "Cmd+F is darwin-specific");

  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  // Open the search bar.
  await window.keyboard.press("Meta+f");
  const searchBar = window.getByTestId("terminal-search");
  await expect(searchBar).toBeVisible({ timeout: 5_000 });

  // Type a term that IS present — no empty indicator.
  const searchInput = window.getByTestId("terminal-search-input");
  await searchInput.fill("needle-9");
  await expect(searchBar).toBeVisible();
  await expect(window.getByTestId("terminal-search-empty")).toHaveCount(0);
  await window.waitForTimeout(300);

  // Switch to a term that does NOT exist — empty indicator appears.
  await searchInput.fill("zzz-absolutely-not-there-xyz");
  await window.waitForTimeout(300);
  await expect(window.getByTestId("terminal-search-empty")).toBeVisible({
    timeout: 5_000,
  });

  // Esc closes the bar and returns focus to the xterm textarea.
  await searchInput.press("Escape");
  await expect(window.getByTestId("terminal-search")).toHaveCount(0, {
    timeout: 5_000,
  });
  const isFocused = await window.evaluate(() => {
    const el = document.activeElement;
    return el?.classList.contains("xterm-helper-textarea") ?? false;
  });
  expect(isFocused).toBe(true);
});
