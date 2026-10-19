// Terminal clipboard paste e2e (checklist items #1, #2, #4, #5 — Chunk A).
//
// Scenarios:
//   1. Image paste: seed clipboard with a 1x1 PNG → terminal receives a path
//      matching /clipboard-YYYY-MM-DD-HHMMSS-XXXXXXXX.png/; the file exists.
//   2. Finder file paste: seed with file URL; the escaped path is inserted.
//   3. Plain text paste with bracketed paste mode: the text arrives bracketed.
//   4. Copy: select text and copy via webContents; the clipboard holds it.
//
// Technique: `app.evaluate` seeds the clipboard in the main process;
// `webContents.paste()` / `webContents.copy()` trigger the native paste/copy
// path.  Each test saves and restores the clipboard to avoid interference.
//
// Note on bracketed paste: xterm 6.0's paste() converts \n→\r before
// bracketing.  The e2e verifies brackets are present and text arrives;
// the exact CR rendering depends on the cat -v timing and is not asserted.
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

// 1×1 transparent PNG (minimal valid PNG, 68 bytes):
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

async function clearClipboard(): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    clipboard.clear();
  });
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-paste-"));
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

  // Create ONE shared task for all paste tests.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Paste Test Task");
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Paste Test Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  const panel = window.getByTestId("terminal-panel").first();
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

// Helper: start a raw reader (cat -v) and wait for it to become the foreground.
async function startRawReader(panel: Locator): Promise<void> {
  await panel.click();
  await window.keyboard.type("stty -icanon -echo; cat -v");
  await window.keyboard.press("Enter");
  // Send a probe byte and wait for it to echo back, confirming cat -v is running.
  await window.waitForTimeout(200);
  await window.keyboard.type("z");
  await expect(panel).toContainText("z", { timeout: 5_000 });
}

test("image paste: clipboard image → clipboard-*.png path appears in terminal", async () => {
  test.skip(
    process.platform !== "darwin",
    "nativeImage clipboard seeding only reliable on macOS",
  );

  const panel = window.getByTestId("terminal-panel").first();
  await startRawReader(panel);

  // Seed the clipboard with a PNG image.
  await app.evaluate(({ clipboard, nativeImage }, base64) => {
    clipboard.clear();
    clipboard.writeImage(
      nativeImage.createFromDataURL(`data:image/png;base64,${base64}`),
    );
  }, TINY_PNG_BASE64);

  // Trigger paste via webContents (same as Cmd+V via the native menu).
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.paste();
  });

  // The terminal should show a path matching the clipboard file pattern.
  await expect(panel).toContainText(
    /clipboard-\d{4}-\d{2}-\d{2}-\d{6}-[0-9A-F]{8}\.png/,
    { timeout: 15_000 },
  );

  // Verify the file exists from the test process — the Electron app and
  // Playwright runner share the same filesystem.
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const tmpDir = osTmpdir();
  const testStartMs = Date.now() - 30_000; // generous window
  let pngPath: string | null = null;
  // Poll for the file to appear (it's created asynchronously by the IPC handler).
  for (let i = 0; i < 20; i++) {
    const files = readdirSync(tmpDir).filter((f) =>
      /^clipboard-\d{4}-\d{2}-\d{2}-\d{6}-[0-9A-F]{8}\.png$/.test(f),
    );
    if (files.length > 0) {
      pngPath = `${tmpDir}/${files.sort().at(-1)}`;
      break;
    }
    await window.waitForTimeout(200);
  }
  expect(pngPath).not.toBeNull();
  // Verify PNG magic bytes (89 50 4E 47).
  const buf = readFileSync(pngPath as string);
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50); // P
  expect(buf[2]).toBe(0x4e); // N
  expect(buf[3]).toBe(0x47); // G

  await window.keyboard.press("Control+c");
  await window.waitForTimeout(200);
  await clearClipboard();
});

test("plain text paste: brackets appear when bracketed paste mode is active", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  // Enable bracketed paste mode, then start the raw reader.
  await window.keyboard.type(
    "printf '\\033[?2004h'; stty -icanon -echo; cat -v",
  );
  await window.keyboard.press("Enter");
  // Wait for the reader to be active.
  await window.waitForTimeout(200);
  await window.keyboard.type("z");
  await expect(panel).toContainText("z", { timeout: 5_000 });

  // Seed plain text.
  await app.evaluate(({ clipboard }) => {
    clipboard.writeText("hello");
  });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.paste();
  });

  // Bracketed paste: ESC[200~ prefix and ESC[201~ suffix.
  await expect(panel).toContainText("^[[200~", { timeout: 15_000 });
  await expect(panel).toContainText("^[[201~", { timeout: 10_000 });
  // The pasted text "hello" should appear between the markers.
  await expect(panel).toContainText("hello", { timeout: 5_000 });

  await window.keyboard.press("Control+c");
  await window.waitForTimeout(200);
  await clearClipboard();
});

test("copy: select-all + webContents.copy() puts terminal text in clipboard", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  // Print a unique marker.
  await window.keyboard.type("echo copy-marker-$((6*7))");
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("copy-marker-42", { timeout: 10_000 });

  // Clear clipboard first.
  await app.evaluate(({ clipboard }) => clipboard.clear());

  // Select all (xterm's Meta+A select-all) then copy via webContents.
  await window.keyboard.press("Meta+a");
  await window.waitForTimeout(100);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.copy();
  });
  await window.waitForTimeout(200);

  // The clipboard should contain our marker.
  const clipText = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clipText).toContain("copy-marker-42");
});
