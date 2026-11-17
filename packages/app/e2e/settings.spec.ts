// The Settings page (docs/settings.md, step 2 of S14) end to end on a
// fresh state dir, through the real seam (renderer → IPC → core →
// config.json, and core's config watcher → config-changed → renderer):
// Cmd+, opens it; "Max tasks running at once" rejects an out-of-range
// draft inline (nothing saved), commits on Enter into config.json and
// shows the changed dot + reset; reset removes the key; a hand edit of
// config.json (branchPrefix) shows up live; an invalid file shows the
// problem banner and fixing it clears it; "Edit in config.json" asks main
// to open the file (HARBORMASTER_OPEN_IN_STUB records the argv); Esc goes
// back to the workspace.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

let app: ElectronApplication;
let window: Page;
let root: string;
let configFile: string;
let stubFile: string;
const mainProcessErrors: string[] = [];

type Config = { branchPrefix?: string; launch?: { maxConcurrent?: number } };

function readConfig(): Config {
  return existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, "utf8")) as Config)
    : {};
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-settings-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  configFile = path.join(stateDir, "config.json");
  stubFile = path.join(root, "open-in.log");
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_OPEN_IN_STUB: stubFile,
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) {
      mainProcessErrors.push(text.trim());
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("Settings applies, resets and follows config.json live", async () => {
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await window.keyboard.press(
    process.platform === "darwin" ? "Meta+Comma" : "Control+Comma",
  );
  const view = window.getByTestId("settings-view");
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute("data-section", "general");
  await expect(window.getByTestId("settings-automation-state")).toHaveText(
    "Automation is on",
  );

  // Agents → Max tasks running at once.
  await window.getByTestId("settings-nav-agents").click();
  const row = window.getByTestId("setting-row-launch.maxConcurrent");
  const field = window.getByTestId("setting-input-launch.maxConcurrent");
  await expect(field).toHaveValue("6");
  await expect(row).toHaveAttribute("data-changed", "false");
  await expect(row.getByTestId("setting-reset")).toBeHidden();

  // Out of range: an inline hint, nothing written.
  await field.fill("0");
  await field.press("Enter");
  await expect(row.getByTestId("setting-error")).toHaveText(
    "Enter a whole number from 1 to 64.",
  );
  expect(readConfig().launch?.maxConcurrent).toBeUndefined();

  // A valid value commits on Enter: config.json, the dot and reset.
  await field.fill("12");
  await field.press("Enter");
  await expect.poll(() => readConfig().launch?.maxConcurrent).toBe(12);
  await expect(row.getByTestId("setting-error")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-changed", "true");
  await expect(row.getByTestId("setting-changed")).toBeVisible();
  await expect(row.getByTestId("setting-reset")).toBeVisible();

  // Reset removes the key and shows the default again.
  await row.getByTestId("setting-reset").click();
  await expect
    .poll(() => "maxConcurrent" in (readConfig().launch ?? {}))
    .toBe(false);
  await expect(field).toHaveValue("6");
  await expect(row).toHaveAttribute("data-changed", "false");

  // A hand edit of config.json shows up live (core's watcher).
  await window.getByTestId("settings-nav-general").click();
  const prefix = window.getByTestId("setting-input-branchPrefix");
  await expect(prefix).toHaveValue("");
  writeFileSync(
    configFile,
    `${JSON.stringify({ ...readConfig(), branchPrefix: "alice/" }, null, 2)}\n`,
  );
  await expect(prefix).toHaveValue("alice/");
  await expect(window.getByTestId("setting-row-branchPrefix")).toHaveAttribute(
    "data-changed",
    "true",
  );

  // An invalid file: the banner (last good values stay); fixing it clears it.
  const good = readFileSync(configFile, "utf8");
  writeFileSync(configFile, '{\n  "branchPrefix": "bob/",\n');
  const banner = window.getByTestId("settings-config-error");
  await expect(banner).toContainText("config.json has a problem:");
  await expect(banner).toContainText("line");
  await expect(prefix).toHaveValue("alice/");
  writeFileSync(configFile, good);
  await expect(banner).toHaveCount(0);

  // "Edit in config.json": main opens the file (stubbed argv).
  await window.getByTestId("settings-edit-config").click();
  await expect
    .poll(() => (existsSync(stubFile) ? readFileSync(stubFile, "utf8") : ""))
    .toContain(configFile);

  // Esc goes back to the workspace.
  await window.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(window.getByTestId("workspace-view")).toBeVisible();
});
