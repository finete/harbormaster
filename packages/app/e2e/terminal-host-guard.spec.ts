// Navigation guard e2e (checklist §0.7, Chunk 0).
//
// Verifies that:
//   1. Dispatching a CDP file drag onto the terminal pane does NOT navigate
//      the window (the `will-navigate` handler + renderer drop guard work).
//   2. Dropping a file outside a terminal pane also does NOT navigate.
//   3. The workspace view is still present after the drag.
//
// This is a simpler variant of terminal-drop.spec.ts focused purely on the
// navigation-guard aspect, independent of whether the path is inserted.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CDPSession,
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
let dummyFile: string;

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

async function dispatchFileDrag(
  cdp: CDPSession,
  x: number,
  y: number,
  filePaths: string[],
): Promise<void> {
  const uriList = filePaths.map((p) => pathToFileURL(p).href).join("\n");
  const dragData = {
    items: [{ mimeType: "text/uri-list", data: uriList }],
    files: filePaths,
    dragOperationsMask: 1,
  };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x, y, data: dragData });
  }
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-guard-"));
  dummyFile = path.join(stateDir, "guard-test.txt");
  writeFileSync(dummyFile, "navigation guard test");

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

  // Create a task and open workspace.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Guard Test Task");
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Guard Test Task").click();
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

test("dropping a file onto the terminal pane does NOT navigate the window", async () => {
  const initialUrl = window.url();

  const panel = window.getByTestId("terminal-panel").first();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  const cdp = await window.context().newCDPSession(window);
  await dispatchFileDrag(cdp, cx, cy, [dummyFile]);
  await cdp.detach();

  await window.waitForTimeout(500);

  // URL must not have changed to a file:// URL.
  expect(window.url()).toBe(initialUrl);

  // Workspace view must still be visible.
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});

test("dropping a file outside the terminal pane does NOT navigate the window", async () => {
  const initialUrl = window.url();

  // Drop at coordinates outside the terminal pane (near top of window).
  const cdp = await window.context().newCDPSession(window);
  await dispatchFileDrag(cdp, 50, 30, [dummyFile]);
  await cdp.detach();

  await window.waitForTimeout(500);

  // URL must not have changed.
  expect(window.url()).toBe(initialUrl);

  // Either workspace or board must be present (UI not destroyed).
  const workspaceCount = await window.getByTestId("workspace-view").count();
  const boardCount = await window.getByTestId("board-view").count();
  expect(workspaceCount + boardCount).toBeGreaterThan(0);
});
