// PTY environment hygiene e2e (checklist item #24, Chunk G).
//
// Verifies that inherited terminal-emulator identity markers are stripped
// and Harbormaster's own identity is set: TERM_PROGRAM=harbormaster,
// COLORTERM=truecolor, and TMUX is removed even when present in the
// launching environment.
//
// Technique: launch the app with `TERM_PROGRAM=ghostty` and
// `TMUX=/tmp/x,1,0` in the process env; then in a shell pane run
// `echo "tp=$TERM_PROGRAM tmux=${TMUX:-none} ct=$COLORTERM"` and
// assert the substituted values show harbormaster's identity.
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
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-env-"));
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      SHELL: "/bin/sh",
      // These should be stripped and replaced by Harbormaster's own identity:
      TERM_PROGRAM: "ghostty",
      TMUX: "/tmp/x,1,0",
      GHOSTTY_RESOURCES_DIR: "/tmp/ghostty",
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

test("pty env: TERM_PROGRAM=harbormaster, COLORTERM=truecolor, inherited markers stripped", async () => {
  // Create a task and open its workspace.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Env Test Task");
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Env Test Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
  await panel.click();

  // Print the env vars we care about.
  await window.keyboard.type(
    'echo "tp=$TERM_PROGRAM tmux=${TMUX:-none} ct=$COLORTERM"',
  );
  await window.keyboard.press("Enter");

  // TERM_PROGRAM should be harbormaster, TMUX should be stripped, COLORTERM should be truecolor.
  await expect(panel).toContainText("tp=harbormaster", { timeout: 10_000 });
  await expect(panel).toContainText("tmux=none", { timeout: 10_000 });
  await expect(panel).toContainText("ct=truecolor", { timeout: 10_000 });
});

test("pty env: GHOSTTY_RESOURCES_DIR is stripped", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  // Check GHOSTTY_RESOURCES_DIR is stripped (should be empty).
  await window.keyboard.type(
    'echo "ghostty=${GHOSTTY_RESOURCES_DIR:-stripped}"',
  );
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("ghostty=stripped", { timeout: 10_000 });
});
