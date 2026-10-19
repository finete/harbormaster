// pi's terminal-setup doc documents a hard gap for embedded/xterm-class
// terminals (VS Code, Zed, and — relevantly here — Harbormaster's own
// @xterm/xterm panes): xterm.js cannot speak the Kitty keyboard protocol,
// so Shift+Enter/Alt+Enter/Ctrl+Enter/Ctrl+Minus collapse to the same bytes
// as their unmodified keys unless the terminal is taught to send CSI-u
// sequences instead (see lib/terminal-key-sequences.ts). This lane proves
// that wiring end to end against a real pty: a plain shell runs `cat -v`
// (echoes exactly the bytes it reads, with control bytes in caret
// notation) as the foreground reader, and `Shift+Enter` must show up as
// the literal `^[[13;2u` bytes — not a plain newline.
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
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-csi-u-"));
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      // A bare /bin/sh plain shell (repo-less task, same no-fixture pattern
      // as smoke.spec.ts): no shell-integration/prompt framework that could
      // race or interfere with the raw byte assertions below.
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

test("Shift+Enter sends a CSI-u sequence to the pty; plain Enter still behaves normally", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("CSI-u Task");
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("CSI-u Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
  await panel.click();

  // --- plain Enter still behaves normally: a typed command runs and the
  // prompt advances (new output appears), proving the custom key handler
  // doesn't swallow ordinary Enter. ---
  await window.keyboard.type("echo plain-enter-$((20+1))");
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("plain-enter-21", { timeout: 10_000 });

  // --- foreground reader: `cat -v` with the pty's line discipline put into
  // raw mode (-icanon, no local echo) so every byte we write reaches `cat
  // -v` immediately and verbatim, with no extra Enter needed to flush a
  // canonical-mode input line and no kernel echo duplicating/garbling the
  // raw escape bytes on screen before `cat -v`'s own caret-notation output
  // does. ---
  await window.keyboard.type("stty -icanon -echo; cat -v");
  await window.keyboard.press("Enter");

  // Intentional fixed wait: no deterministic "ready" signal from a shell-less
  // raw-mode reader; a short settle avoids a flaky race against `cat`'s exec.
  await window.waitForTimeout(300);

  await window.keyboard.press("Shift+Enter");
  await expect(panel).toContainText("^[[13;2u", { timeout: 10_000 });

  // End the raw-mode reader so afterAll's close() doesn't have to tear down
  // a shell stuck without local echo/canonical processing.
  await window.keyboard.press("Control+c");
});
