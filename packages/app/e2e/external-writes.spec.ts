// The state files are shared with external writers (the pi extension's
// /todev//toawait//todone, the migration CLI). The main process watches the
// state dir and republishes the board, so those writes appear in the app
// without waiting for the 30s refresh tick. This spec drives a write through
// a second core instance — exactly what the extension does — and expects the
// board to update on its own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "playwright/test";

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-extwrites-"));
  stateDir = path.join(root, "state");
  app = await electron.launch({
    args: [path.join(__dirname, "..", "out", "main", "index.js")],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
    },
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.includes("[main] uncaughtException")) mainProcessErrors.push(text);
  });
  window = await app.firstWindow();
  await window.getByTestId("sidebar").waitFor();
});

test.afterAll(async () => {
  await app.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("a task created by an external core instance appears on the board without a manual refresh", async () => {
  // Write the way the extension does: a separate core over the same state dir.
  const external = createCore({ stateDir });
  await external.commands.createTask({
    title: "Written From Outside",
    initialPrompt: "",
  });

  await window.getByTestId("board-button").click();
  await expect(
    window
      .getByTestId("column-backlog-cards")
      .locator('[data-testid^="card-"]')
      .filter({ hasText: "Written From Outside" }),
    // Far below the 30s refresh tick: this must be the file watcher.
  ).toBeVisible({ timeout: 10_000 });
});
