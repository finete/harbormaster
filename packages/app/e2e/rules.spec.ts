// Rules page e2e (docs/rules-page.md): the wiring seam, one launch. The
// state dir gets the shipped default rules (core's `ensureDefaultRules`),
// one repository-less task and a seeded audit log (the event that fired a
// rule plus the rule's action on that task). Covers: the sidebar Rules row
// and Cmd/Ctrl+Shift+R open the page; the defaults are listed under the
// global header by label; clicking a rule opens the sheet with On / If /
// Do; the Activity tab lists the seeded action, which expands to its
// event's data; its rule name returns to the Rules tab with the sheet open;
// its task link opens the task's workspace.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { writeStatusPi } from "./fake-pi";

// Core's Rules-page API (docs/rules-page.md "Contract": `condition` outline,
// per-rule `activity`) is merged; these assertions run against it.
const CORE_READY = true;

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const GLOBAL_KEY = "rules.yaml#pr-merged-enter-deploy";

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
let taskId: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-rules-"));
  stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: false, codeRoot, branchPrefix: "" }),
  );
  const external = createCore({ stateDir });
  await external.commands.ensureDefaultRules();
  const task = await external.commands.createTask({
    title: "Seeded task",
    initialPrompt: "",
  });
  taskId = task.id;

  // The audit log as the rules tick writes it (one UTC-day file).
  const at = new Date(Date.now() - 60_000).toISOString();
  const eventId = "seed-event-1";
  mkdirSync(path.join(stateDir, "events"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "events", `${at.slice(0, 10)}.jsonl`),
    `${[
      {
        kind: "event",
        at,
        taskId,
        event: {
          specversion: "1.0",
          id: eventId,
          source: "github",
          type: "github.pr.stateChanged",
          subject: `task/${taskId}`,
          time: at,
          data: { from: "OPEN", to: "MERGED-SEEDED" },
        },
      },
      {
        kind: "action",
        at,
        taskId,
        ruleId: "pr-merged-enter-deploy",
        ruleLabel: "PR merged",
        file: "rules.yaml",
        line: 38,
        eventId,
        eventType: "github.pr.stateChanged",
        action: "move",
        with: { to: "done" },
        from: { state: "dev" },
        outcome: "applied",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: writeStatusPi(root),
    },
  });
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) mainProcessErrors.push(text);
  };
  app.process().stdout?.on("data", onChunk);
  app.process().stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.getByTestId("sidebar").waitFor();
});

test.afterAll(async () => {
  await app?.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("sidebar + shortcut open Rules; list, sheet, Activity and cross-links", async () => {
  const view = window.getByTestId("rules-view");

  // The sidebar row opens the page (sidebar stays); Esc goes back.
  await window.getByTestId("rules-button").click();
  await expect(view).toBeVisible();
  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(window.getByTestId("rules-button")).toHaveAttribute(
    "data-active",
    "true",
  );
  await window.keyboard.press("Escape");
  await expect(view).toHaveCount(0);

  // Cmd/Ctrl+Shift+R opens it too.
  await window.keyboard.press(`${MOD}+Shift+R`);
  await expect(view).toBeVisible();

  // The shipped defaults, by label, under the global header.
  const global = window.getByTestId("rules-file-rules.yaml");
  await expect(global.getByTestId("rules-file-header")).toContainText(
    "applies to every repository without an override",
  );
  for (const label of [
    "PR merged",
    "Needs changes",
    "Review requested",
    "Review request",
  ]) {
    await expect(
      global
        .getByTestId("rule-label")
        .filter({ hasText: new RegExp(`^${label}$`) }),
    ).toHaveCount(1);
  }
  const row = window.getByTestId(`rule-row-${GLOBAL_KEY}`);
  await expect(row.getByTestId("rule-do-chip")).toHaveText(
    "move → await:deploy",
  );
  if (CORE_READY) {
    // The activity fold marks the seeded applied action.
    await expect(row.getByTestId("rule-dot")).toHaveAttribute("data-dot", "ok");
  }

  // Click → the sheet shows On / If / Do.
  await row.click();
  const sheet = window.getByTestId("rule-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("rule-sheet-label")).toHaveText("PR merged");
  await expect(sheet.getByTestId("rule-sheet-on")).toContainText("github.pr.*");
  await expect(sheet.getByTestId("rule-sheet-if")).toBeVisible();
  await expect(sheet.getByTestId("rule-sheet-do")).toContainText(
    "move → await:deploy",
  );
  if (CORE_READY) {
    // `If` is core's ALL/ANY outline of the rule's CEL, leaves verbatim.
    await expect(sheet.getByTestId("rule-if-all").first()).toBeVisible();
    expect(await sheet.getByTestId("rule-if-leaf").count()).toBeGreaterThan(1);
  }
  // ↓ swaps the sheet in place; Esc closes it (page stays).
  await window.keyboard.press("ArrowDown");
  await expect(sheet.getByTestId("rule-sheet-label")).toHaveText(
    "Needs changes",
  );
  await window.keyboard.press("ArrowUp");
  await expect(sheet.getByTestId("rule-sheet-label")).toHaveText("PR merged");

  // "View all activity for this rule" → Activity, filtered to the rule.
  await sheet.getByTestId("rule-sheet-view-all").click();
  await expect(view).toHaveAttribute("data-tab", "activity");
  await expect(window.getByTestId("rules-activity-filter-rule")).toContainText(
    "PR merged",
  );
  const action = window
    .getByTestId("rules-activity-row")
    .and(window.locator('[data-kind="action"]'));
  await expect(action).toHaveCount(1);
  await expect(action.getByTestId("rules-activity-verb")).toHaveText(
    "Dev → Done",
  );
  // Expands to the triggering event's data.
  await action.getByTestId("rules-activity-verb").click();
  await expect(window.getByTestId("rules-activity-trigger")).toContainText(
    "MERGED-SEEDED",
  );
  // The filter chip is removable.
  await window.getByTestId("rules-activity-filter-rule-remove").click();
  await expect(window.getByTestId("rules-activity-filter-rule")).toHaveCount(0);

  // Rule name → Rules tab with that rule's sheet open.
  await action.getByTestId("rules-activity-rule-link").click();
  await expect(view).toHaveAttribute("data-tab", "rules");
  await expect(sheet.getByTestId("rule-sheet-label")).toHaveText("PR merged");

  // Leaving and reopening keeps the selection.
  await window.keyboard.press(`${MOD}+Shift+R`);
  await expect(view).toHaveCount(0);
  await window.getByTestId("rules-button").click();
  await expect(sheet.getByTestId("rule-sheet-label")).toHaveText("PR merged");
  await window.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Activity → task link opens the task's workspace.
  await window.getByTestId("rules-tab-activity").click();
  await action.getByTestId("rules-task-link").click();
  await expect(view).toHaveCount(0);
  await expect(window.getByTestId(`task-workspace-${taskId}`)).toBeVisible();
});
