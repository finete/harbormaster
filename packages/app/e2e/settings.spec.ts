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
//
// Step 3 (S10/S11/S13): GitHub & sources (gh account via a fake gh, the
// github toggles and the interval in minutes stored as ms, an add-on
// source's automatic form from its settingsSchema, validated by core),
// Inbox & messaging, the desktop notifications switch, and the board's
// "Automation paused" strip following config.json live.
import {
  chmodSync,
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

type Config = {
  branchPrefix?: string;
  automation?: boolean;
  launch?: { maxConcurrent?: number };
  notifications?: { enabled?: boolean };
  messaging?: { loopCap?: number; directRoutes?: string };
  inbox?: { priorityFilter?: string };
  sources?: Record<
    string,
    { enabled?: boolean; settings?: Record<string, unknown> }
  >;
};

function readConfig(): Config {
  return existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, "utf8")) as Config)
    : {};
}

function writeConfig(config: Config): void {
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

/** A `gh` signed in as `octo-e2e` that knows no pull requests. */
function writeFakeGh(): string {
  const file = path.join(root, "fake-gh");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "auth status" ]; then',
      "  echo 'github.com'",
      "  echo '  ✓ Logged in to github.com account octo-e2e (keyring)'",
      "  echo '  - Active account: true'",
      "  exit 0",
      "fi",
      "printf '[]'",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

/** An add-on with one source whose settingsSchema drives an automatic form. */
function writePingerAddon(stateDir: string): void {
  const dir = path.join(stateDir, "addons", "pinger");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "addon.json"),
    JSON.stringify({
      name: "pinger-addon",
      version: "0.1.0",
      description: "Pings a URL",
      provides: { sources: ["pinger"] },
    }),
  );
  writeFileSync(
    path.join(dir, "source.mjs"),
    `export default {
  id: "pinger",
  title: "Pinger",
  interval: 3600000,
  settingsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      threshold: { type: "integer", minimum: 1, title: "Alert threshold", description: "Failures before an inbox item." },
      region: { type: "string", enum: ["eu", "us"], title: "Region" },
      targets: { type: "array", items: { type: "string" }, title: "Targets" },
    },
  },
  async snapshot() { return []; },
};
`,
  );
}

async function openSettings(section: string): Promise<void> {
  if (!(await window.getByTestId("settings-view").isVisible())) {
    await window.keyboard.press(
      process.platform === "darwin" ? "Meta+Comma" : "Control+Comma",
    );
  }
  await window.getByTestId(`settings-nav-${section}`).click();
  await expect(window.getByTestId("settings-view")).toHaveAttribute(
    "data-section",
    section,
  );
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-settings-"));
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  configFile = path.join(stateDir, "config.json");
  stubFile = path.join(root, "open-in.log");
  writePingerAddon(stateDir);
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_OPEN_IN_STUB: stubFile,
      HARBORMASTER_GH_COMMAND: writeFakeGh(),
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

test("GitHub & sources: account, toggles, minutes stored as ms, add-on form", async () => {
  await openSettings("github");
  await expect(window.getByTestId("settings-github-account")).toHaveText(
    "Connected as octo-e2e",
  );

  // Friendly toggles write the github source's settings.
  const reviews = window.getByTestId(
    "setting-input-sources.github.settings.watchReviewRequests",
  );
  await expect(reviews).toHaveAttribute("aria-checked", "false");
  await reviews.click();
  await expect
    .poll(() => readConfig().sources?.github?.settings?.watchReviewRequests)
    .toBe(true);
  await expect(reviews).toHaveAttribute("aria-checked", "true");

  // The interval shows minutes and stores milliseconds; a hand edit in ms
  // shows up as minutes.
  const intervalKey = "sources.github.settings.searchIntervalMs";
  const interval = window.getByTestId(`setting-input-${intervalKey}`);
  await expect(interval).toHaveValue("5");
  await interval.fill("0");
  await interval.press("Enter");
  await expect(
    window
      .getByTestId(`setting-row-${intervalKey}`)
      .getByTestId("setting-error"),
  ).toHaveText("Enter a whole number of minutes from 1 to 1440.");
  await interval.fill("10");
  await interval.press("Enter");
  await expect
    .poll(() => readConfig().sources?.github?.settings?.searchIntervalMs)
    .toBe(600_000);
  await interval.blur(); // a focused field keeps its draft
  const config = readConfig();
  writeConfig({
    ...config,
    sources: {
      ...config.sources,
      github: {
        ...config.sources?.github,
        settings: {
          ...config.sources?.github?.settings,
          searchIntervalMs: 180_000,
        },
      },
    },
  });
  await expect(interval).toHaveValue("3");

  // GitHub off.
  await window.getByTestId("setting-input-sources.github.enabled").click();
  await expect.poll(() => readConfig().sources?.github?.enabled).toBe(false);

  // The add-on source: its switch and a form drawn from its schema, with
  // core checking writes against that schema.
  const card = window.getByTestId("settings-source-pinger");
  await expect(card).toContainText("Pinger");
  await expect(card).toContainText("From the add-on pinger-addon: Pings a URL");
  const thresholdKey = "sources.pinger.settings.threshold";
  const thresholdRow = window.getByTestId(`setting-row-${thresholdKey}`);
  await expect(thresholdRow).toContainText("Alert threshold");
  await expect(thresholdRow).toContainText("Failures before an inbox item.");
  const threshold = window.getByTestId(`setting-input-${thresholdKey}`);
  await threshold.fill("0");
  await threshold.press("Enter");
  await expect(thresholdRow.getByTestId("setting-error")).toHaveText(
    "Enter a whole number of at least 1.",
  );
  await threshold.fill("4");
  await threshold.press("Enter");
  await expect
    .poll(() => readConfig().sources?.pinger?.settings?.threshold)
    .toBe(4);
  await expect(thresholdRow).toHaveAttribute("data-changed", "true");
  await window
    .getByTestId("setting-input-sources.pinger.settings.region")
    .click();
  await window
    .getByTestId("setting-input-sources.pinger.settings.region-option")
    .filter({ hasText: "us" })
    .click();
  await expect
    .poll(() => readConfig().sources?.pinger?.settings?.region)
    .toBe("us");
  await expect(
    window.getByTestId("setting-input-sources.pinger.settings.targets"),
  ).toHaveText("Edit in config.json");
  await window.getByTestId("setting-input-sources.pinger.enabled").click();
  await expect.poll(() => readConfig().sources?.pinger?.enabled).toBe(false);
  await thresholdRow.getByTestId("setting-reset").click();
  await expect
    .poll(() => "threshold" in (readConfig().sources?.pinger?.settings ?? {}))
    .toBe(false);
});

test("Inbox & messaging and desktop notifications save", async () => {
  await openSettings("inbox");
  // "Messages between tasks": default is the same task tree; picking another option saves it.
  const routes = window.getByTestId("setting-input-messaging.directRoutes");
  await expect(routes).toContainText("Same task tree");
  await routes.click();
  await window
    .getByTestId("setting-input-messaging.directRoutes-option")
    .filter({ hasText: "Parent and child" })
    .click();
  await expect(routes).toContainText("Parent and child");
  await expect
    .poll(() => readConfig().messaging?.directRoutes)
    .toBe("parent-and-child");
  const loopCap = window.getByTestId("setting-input-messaging.loopCap");
  await expect(loopCap).toHaveValue("8");
  await loopCap.fill("12");
  await loopCap.press("Enter");
  await expect.poll(() => readConfig().messaging?.loopCap).toBe(12);
  const filter = window.getByTestId("settings-priority-filter-state");
  await expect(filter).toHaveText("Not set: each item's own priority applies");
  writeConfig({
    ...readConfig(),
    inbox: { priorityFilter: 'item.kind == "rule"' },
  });
  await expect(filter).toContainText("Custom filter set");
  await window.getByTestId("settings-priority-filter-edit").click();

  await openSettings("general");
  const notify = window.getByTestId("setting-input-notifications.enabled");
  await expect(notify).toHaveAttribute("aria-checked", "true");
  await notify.click();
  await expect.poll(() => readConfig().notifications?.enabled).toBe(false);
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings-view")).toHaveCount(0);
});

test("the board shows 'Automation paused' while automation is off", async () => {
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
  const banner = window.getByTestId("automation-paused-banner");
  await expect(banner).toHaveCount(0);
  // A hand edit turns it off: the strip appears; on again: it goes away.
  writeConfig({ ...readConfig(), automation: false });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    "Automation paused · Rules won't move cards",
  );
  writeConfig({ ...readConfig(), automation: true });
  await expect(banner).toHaveCount(0);
  // "Turn on" uses the Rules page's command.
  writeConfig({ ...readConfig(), automation: false });
  await expect(banner).toBeVisible();
  await window.getByTestId("automation-paused-turn-on").click();
  await expect(banner).toHaveCount(0);
  expect(readConfig().automation).toBe(true);
});
