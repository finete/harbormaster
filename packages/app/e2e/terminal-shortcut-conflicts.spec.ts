// Terminal shortcut conflicts e2e (checklist item #9, Chunk D).
//
// Verifies that Ctrl+W and Ctrl+B reach the pty on macOS (not stolen by
// app shortcuts) and that the workspace view is still visible afterwards.
// Also verifies Ctrl+Shift+ArrowUp passes through.
//
// The fix: `isCloseTabChord` and `isSidebarCycleChord` in app-shortcuts.ts
// require Meta (Cmd) on darwin, not Ctrl.
//
// darwin-only tests (Ctrl+W is delete-word-backward on mac, not close-tab).
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

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-shortcuts-"));
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
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

test.describe("Ctrl+W, Ctrl+B, Ctrl+Shift+Up reach the pty on darwin (not stolen by app shortcuts)", () => {
  test.skip(
    process.platform !== "darwin",
    "darwin-only: Ctrl+W/B steal fix is darwin-specific",
  );

  test("Ctrl+W → ^W, Ctrl+B → ^B, Ctrl+Shift+Up → ^[[1;6A reach the pty; workspace stays visible", async () => {
    await window.getByTestId("sidebar-new-task-button").click();
    await expect(window.getByTestId("new-task-composer")).toBeVisible();
    await window.getByTestId("new-task-title-input").fill("Shortcut Test");
    await chooseWhere(window, "none");
    await submitAs(window, "park");
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    await cardLocator("Shortcut Test").click();
    await expect(window.getByTestId("workspace-view")).toBeVisible();

    const panel = window.getByTestId("terminal-panel").first();
    await expect(panel).toHaveAttribute("data-received-output", "true", {
      timeout: 20_000,
    });
    await panel.click();

    // One shared raw reader for all three combos.
    await window.keyboard.type("stty -icanon -echo; cat -v");
    await window.keyboard.press("Enter");
    // Intentional fixed wait: no deterministic ready signal from raw-mode pty
    // reader; prevents first keypress from racing cat's exec and being dropped.
    await window.waitForTimeout(300);

    // Ctrl+W — regression: must send ^W to the pty, not close the task.
    await window.keyboard.press("Control+w");
    await expect(panel).toContainText("^W", { timeout: 10_000 });
    await expect(window.getByTestId("workspace-view")).toBeVisible();

    // Ctrl+B — regression: must send ^B to the pty, not toggle the board.
    await window.keyboard.press("Control+b");
    await expect(panel).toContainText("^B", { timeout: 10_000 });
    await expect(window.getByTestId("workspace-view")).toBeVisible();

    // Ctrl+Shift+Up: must send the raw CSI sequence, not cycle the sidebar.
    await window.keyboard.press("Control+Shift+ArrowUp");
    // CSI [1;6A = Ctrl+Shift+Up: modifier 6 (ctrl+shift), A = up.
    await expect(panel).toContainText("^[[1;6A", { timeout: 10_000 });
    await expect(window.getByTestId("workspace-view")).toBeVisible();

    await window.keyboard.press("Control+c");
  });
});
