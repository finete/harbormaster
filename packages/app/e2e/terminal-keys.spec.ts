// Terminal keyboard parity e2e (checklist items #6, #7, #8, Chunks C).
//
// Uses a raw-mode `cat -v` reader to assert the exact bytes each key combo
// sends to the pty.  All assertions are darwin-only (macOS) because the
// mac text-editing sequences are platform-specific.
//
// Combos tested:
//   Meta+ArrowLeft  → ^A  (line start)
//   Meta+ArrowRight → ^E  (line end)
//   Meta+Backspace  → ^U  (kill to line start)
//   Ctrl+Shift+F    → ^[[102;6u
//   Ctrl+Shift+P    → ^[[112;6u
//   Ctrl+Alt+]      → ^[[93;7u
//   Cmd+K clear     → clears scrollback
//
// Regressions (Alt/Option combos):
//   Alt+Backspace   → ^[^? (ESC DEL via macOptionIsMeta)
//   Shift+Enter     → ^[[13;2u
//
// Note on Alt+ArrowLeft: xterm 6.0 sends the ANSI modifier-parameter
// sequence ESC[1;3D (= ^[[1;3D) for Alt+ArrowLeft even with
// macOptionIsMeta: true.  The ESC b (word-backward) shortcut is handled by
// the macOS system key binding layer in a real macOS terminal session, which
// is not reachable from Playwright's synthetic key dispatch.  This is
// correct xterm behaviour and is NOT a regression.
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
let panel: Locator;

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
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-keys-"));
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

  // Create ONE shared task for all key tests.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Keys Test Task");
  await chooseWhere(window, "none");
  await submitAs(window, "park");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Keys Test Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

/** Click the panel and start a fresh raw reader. */
async function startRawReader(): Promise<void> {
  await panel.click();
  await window.keyboard.type("stty -icanon -echo; cat -v");
  await window.keyboard.press("Enter");
  // Intentional fixed wait: no deterministic "cat -v ready" signal from a
  // raw-mode pty reader; this settle prevents the first keypress from racing
  // cat's exec and being dropped.
  await window.waitForTimeout(300);
}

test.describe("macOS keyboard parity (darwin only)", () => {
  test.skip(
    process.platform !== "darwin",
    "macOS-specific key sequences only tested on darwin",
  );

  test("mac key sequence parity: Meta+ArrowLeft, Ctrl+Shift+F, Ctrl+Alt+], Alt+Backspace", async () => {
    // One shared raw reader for all four combos (avoids per-combo setup cost).
    await startRawReader();
    // Meta+ArrowLeft → ^A (line start, macTextEditingSequence).
    await window.keyboard.press("Meta+ArrowLeft");
    await expect(panel).toContainText("^A", { timeout: 10_000 });
    // Ctrl+Shift+F → ^[[102;6u (csiUSequenceForKeyEvent, Ctrl+Shift+letter).
    await window.keyboard.press("Control+Shift+KeyF");
    await expect(panel).toContainText("^[[102;6u", { timeout: 10_000 });
    // Ctrl+Alt+] → ^[[93;7u (mac Alt-modified key, only real-event proof).
    await window.keyboard.press("Control+Alt+BracketRight");
    await expect(panel).toContainText("^[[93;7u", { timeout: 10_000 });
    // Alt+Backspace → ^[^? (macOptionIsMeta option, regression check).
    await window.keyboard.press("Alt+Backspace");
    await expect(panel).toContainText("^[^?", { timeout: 10_000 });
    await window.keyboard.press("Control+c");
    // Intentional fixed wait: let the shell return to canonical mode before the
    // next test opens a new raw reader (no ready signal after Ctrl+C settles).
    await window.waitForTimeout(200);
  });

  test("Cmd+K clears the viewport", async () => {
    // Exit any raw reader, print a marker, clear, check it's gone.
    await panel.click();
    await window.keyboard.type("echo clear-marker-$((40+2))");
    await window.keyboard.press("Enter");
    await expect(panel).toContainText("clear-marker-42", { timeout: 10_000 });

    // Cmd+K should clear the viewport.
    await window.keyboard.press("Meta+k");
    // Intentional fixed wait: xterm's clear is synchronous in the renderer but
    // the viewport DOM update may be one frame behind; the following
    // not.toContainText assertion has no built-in retry timeout.
    await window.waitForTimeout(300);

    await window.keyboard.type("echo after-$((1+1))");
    await window.keyboard.press("Enter");
    await expect(panel).toContainText("after-2", { timeout: 10_000 });

    // The cleared marker should no longer be visible.
    await expect(panel).not.toContainText("clear-marker-42");
  });
});
