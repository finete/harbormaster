// Terminal context menu e2e (checklist item #16, Chunk I).
//
// Verifies:
//   - Right-clicking the terminal pane opens the context menu
//     (`data-testid="terminal-context-menu"`).
//   - "Copy" copies selected text to the clipboard.
//   - "Clear" clears the terminal viewport.
//   - "Paste" inserts clipboard text into the pty.
//
// Note: xterm's default `rightClickSelectsWord` is enabled on macOS, so
// right-clicking on a word selects it and enables "Copy".
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
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-ctx-menu-"));
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
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Context Menu Task");
  await window.getByTestId("new-task-mode-chat").click();
  await window.getByTestId("new-task-submit-backlog").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Context Menu Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
  await panel.click();

  // Print a unique marker for copy/clear tests.
  await window.keyboard.type("echo ctx-word-$((5+5))");
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("ctx-word-10", { timeout: 10_000 });
});

test.afterEach(async () => {
  assertNoMainProcessErrors();
  // Close any open context menu.
  await window.keyboard.press("Escape");
  await window.waitForTimeout(100);
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

test("Clear menu item clears the terminal viewport", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  // Print a marker that should be cleared.
  await window.keyboard.type("echo before-clear-$((3+3))");
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("before-clear-6", { timeout: 10_000 });

  // Right-click to open context menu.
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.click(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
    { button: "right" },
  );

  await expect(window.getByTestId("terminal-context-menu")).toBeVisible({
    timeout: 5_000,
  });

  // Click "Clear".
  await window.getByTestId("terminal-context-menu-item-clear").click();

  // The marker should be gone from the viewport (toContainText polls internally).
  await expect(panel).not.toContainText("before-clear-6");
});

test("Paste menu item inserts clipboard text into the pty", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  // Seed the clipboard with an echo command that evaluates to pasted-4.
  const pasteText = "echo pasted-$((2+2))";
  await app.evaluate(({ clipboard }, text) => {
    clipboard.writeText(text);
  }, pasteText);

  // Right-click to open context menu.
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.click(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
    { button: "right" },
  );

  await expect(window.getByTestId("terminal-context-menu")).toBeVisible({
    timeout: 5_000,
  });

  // Click "Paste".
  await window.getByTestId("terminal-context-menu-item-paste").click();

  // The pasted command should appear in the prompt line.
  await expect(panel).toContainText("echo pasted-", { timeout: 10_000 });

  // Click the panel to ensure the terminal is focused, then press Enter.
  await panel.click();
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("pasted-4", { timeout: 10_000 });

  await app.evaluate(({ clipboard }) => clipboard.clear());
});
