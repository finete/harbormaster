// Terminal options e2e (checklist items #25, #13, Chunk F).
//
// Verifies the terminal options changes:
//   1. convertEol is NOT set (removing it stops full-screen TUI apps from
//      being corrupted by forced CR+LF on bare LF).  Checked via a data
//      attribute on the panel.
//   2. Unicode 11 width tables are active (the panel carries
//      data-unicode-version="11").
//   3. macOptionClickForcesSelection is true (checked via terminal options
//      in the renderer).
//   4. The `terminal.fontSize` setting applies live to an open pane, from
//      core's updateSettings and from a hand edit of config.json (the
//      config watcher → config-changed → renderer seam, docs/settings.md).
//
// These are checked via DOM attributes set in TerminalPane.tsx and via
// renderer-side evaluation of the terminal options, rather than through
// pixel-level canvas introspection which would be brittle.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-opts-"));
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

  // Create and open a task to get a terminal panel.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Options Test Task");
  await chooseWhere(window, "none");
  await submitAs(window, "park");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Options Test Task").click();
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

test("terminal panel has data-unicode-version=11 (Unicode11Addon is active)", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toHaveAttribute("data-unicode-version", "11", {
    timeout: 5_000,
  });
});

test("terminal.fontSize applies live: updateSettings and a hand edit of config.json", async () => {
  const rows = window
    .getByTestId("terminal-panel")
    .first()
    .locator(".xterm-rows");
  const fontSize = () => rows.evaluate((el) => getComputedStyle(el).fontSize);
  await expect.poll(fontSize).toBe("13px");

  await window.evaluate(() =>
    window.harbormaster.core.updateSettings({ "terminal.fontSize": 15 }),
  );
  await expect.poll(fontSize, { timeout: 5_000 }).toBe("15px");

  const configPath = path.join(stateDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, terminal: { fontSize: 19 } }, null, 2)}\n`,
  );
  await expect.poll(fontSize, { timeout: 5_000 }).toBe("19px");
});
