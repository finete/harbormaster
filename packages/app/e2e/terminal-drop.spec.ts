// Drag-and-drop file integration e2e (checklist item #3, Chunk B).
//
// Verifies:
//   1. Dragging real files onto the terminal pane → escaped paths inserted.
//   2. Dropping a file outside the terminal pane does NOT navigate the window.
//
// Technique: CDP `Input.dispatchDragEvent` with real temp files.  The files
// array in the drag event maps to File objects that `webUtils.getPathForFile`
// can resolve in the preload.
//
// Note: CDP Input.dispatchDragEvent with the `files` field populates
// `dataTransfer.files` in the renderer.  However, `webUtils.getPathForFile`
// may return an empty string for CDP-synthetic File objects in some Electron
// builds.  If getPathForFile returns empty, the drop handler falls through to
// the text/uri-list path.  We therefore also set `text/uri-list` as a data
// item so the test is robust either way.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Dispatch a fake file drag onto a point using CDP Input.dispatchDragEvent. */
async function dispatchFileDrag(
  cdp: CDPSession,
  x: number,
  y: number,
  filePaths: string[],
): Promise<void> {
  const uriList = filePaths.map((p) => pathToFileURL(p).href).join("\n");
  const dragData = {
    items: [
      {
        mimeType: "text/uri-list",
        data: uriList,
      },
    ],
    files: filePaths,
    dragOperationsMask: 1,
  };

  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", {
      type,
      x,
      y,
      data: dragData,
    });
  }
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-drop-"));
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

test("drag-drop file onto terminal pane → escaped path inserted", async () => {
  // Create temp files — one with a space in the name.
  const fileDir = path.join(stateDir, "drop-files");
  mkdirSync(fileDir, { recursive: true });
  const fileA = path.join(fileDir, "drop test.txt");
  const fileB = path.join(fileDir, "other.txt");
  writeFileSync(fileA, "file a content");
  writeFileSync(fileB, "file b content");

  // Open a task and workspace.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Drop Test Task");
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Drop Test Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
  await panel.click();

  // Enter raw mode so we see exactly what's inserted.
  await window.keyboard.type("stty -icanon -echo; cat -v");
  await window.keyboard.press("Enter");
  await window.waitForTimeout(300);

  // Get the terminal panel's bounding box for the drop target.
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  // Dispatch via CDP.
  const cdp = await window.context().newCDPSession(window);
  await dispatchFileDrag(cdp, cx, cy, [fileA, fileB]);
  await cdp.detach();

  // The panel should contain the escaped filenames.
  // "drop test.txt" → "drop\ test.txt"
  await expect(panel).toContainText("drop\\ test.txt", { timeout: 15_000 });
  await expect(panel).toContainText("other.txt", { timeout: 5_000 });

  // Window URL should be unchanged (no navigation).
  const url = window.url();
  expect(url).not.toMatch(/^file:\/\/.*drop/);

  await window.keyboard.press("Control+c");
});

test("drag-drop a file outside the terminal pane does NOT navigate the window", async () => {
  const initialUrl = window.url();

  // Create a temp file.
  const dummyFile = path.join(stateDir, "outside-drop.txt");
  writeFileSync(dummyFile, "should not navigate");

  // Find the sidebar (non-terminal area) bounding box for the drop target.
  const sidebar = window.locator('[data-testid="sidebar"]');
  const sidebarBox = await sidebar.boundingBox();

  // If sidebar isn't visible (board view), use the board area.
  const dropTarget = sidebarBox
    ? {
        x: sidebarBox.x + sidebarBox.width / 2,
        y: sidebarBox.y + sidebarBox.height / 2,
      }
    : { x: 50, y: 200 };

  const cdp = await window.context().newCDPSession(window);
  await dispatchFileDrag(cdp, dropTarget.x, dropTarget.y, [dummyFile]);
  await cdp.detach();

  await window.waitForTimeout(500);

  // The URL should still be the same (no navigation to file://).
  expect(window.url()).toBe(initialUrl);

  // The workspace view or board should still be visible.
  const workspaceOrBoard =
    (await window.getByTestId("workspace-view").count()) > 0 ||
    (await window.getByTestId("board-view").count()) > 0;
  expect(workspaceOrBoard).toBe(true);
});
