// Costs (docs/costs.md): per-task token usage in the app. Seeds Done tasks
// whose bindings point at Pi-format transcripts with usage + cost (see
// fake-pi.ts's writePiUsageSession); core's startup backfill drain counts
// them all at once and pushes the board, so every assertion below goes
// through the real seam: adapter → core → IPC → renderer. 40 extra small
// tasks prove the drain counts the whole board on startup (16 per 30s
// refresh tick left most of them missing), and a working task whose
// transcript does not exist yet keeps "counting 1 more…" on the totals
// line until it shows up. One launch, three surfaces:
// the Costs page (filters, totals, group-by, open a task), its CSV export
// (main's save path stubbed by HARBORMASTER_E2E_SAVE_PATH), and the
// workspace usage chip + popover (with its refresh) plus the board line.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
import {
  type PiUsageTurn,
  piUsageEntry,
  writePiUsageSession,
  writeShellPi,
} from "./fake-pi";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

const opus = (tokens: Omit<PiUsageTurn, "model">): PiUsageTurn => ({
  model: "claude-opus-4-5",
  ...tokens,
});

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let window: Page;
let root: string;
let savePath: string;
let parentSession: string;
let waitingSession: string;

/** Small extra Done tasks, more than the old 16-per-tick backfill counted. */
const BULK = 40;
const bulkId = (index: number) => `bulk-${String(index).padStart(2, "0")}`;
const bulkTokens = (): Omit<PiUsageTurn, "model"> => ({
  input: 1_000,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});
const mainProcessErrors: string[] = [];

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-costs-"));
  const stateDir = path.join(root, "state");
  const sessions = path.join(root, "sessions");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  savePath = path.join(root, "export.csv");

  const now = Date.now();
  const recent = new Date(now - 5 * 60_000).toISOString();
  const old = new Date(now - 60 * 24 * 60 * 60_000).toISOString();
  const session = (name: string, turns: PiUsageTurn[]): string => {
    const file = path.join(sessions, `2026-11-16T10-00-00-000Z_${name}.jsonl`);
    writePiUsageSession(file, name, turns);
    return file;
  };
  // 1.2M tokens, ~$3.50 over two opus turns.
  parentSession = session("aaaaaaaa-parent", [
    opus({
      input: 100_000,
      output: 20_000,
      cacheRead: 900_000,
      cacheWrite: 14_000,
      cost: 2.5,
    }),
    opus({
      input: 50_000,
      output: 10_000,
      cacheRead: 100_000,
      cacheWrite: 6_000,
      cost: 1,
    }),
  ]);
  const childSession = session("bbbbbbbb-child", [
    {
      model: "gpt-5",
      input: 200_000,
      output: 100_000,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.75,
    },
  ]);
  const smallSession = session("cccccccc-small", [
    opus({ input: 5_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 }),
  ]);
  const tinySession = session("dddddddd-tiny", [
    opus({ input: 2_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 }),
  ]);
  const archivedSession = session("eeeeeeee-archived", [
    {
      model: "claude-haiku-4-5",
      input: 9_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 9,
    },
  ]);
  // Its spend is 60 days old: the range filter goes by the transcript's
  // mtime (usage.lastActivityAt), not by when the backfill counted it.
  utimesSync(archivedSession, new Date(old), new Date(old));
  const bulkSessions = Array.from({ length: BULK }, (_, index) =>
    session(`${String(index).padStart(8, "0")}-bulk`, [opus(bulkTokens())]),
  );
  // Written later, by the test: until then the task's usage is pending.
  waitingSession = path.join(
    sessions,
    "2026-11-16T10-00-00-000Z_ffffffff-waiting.jsonl",
  );

  const task = (
    id: string,
    title: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    kind: "temp_task",
    state: "done",
    title,
    initialPrompt: "",
    createdAt: recent,
    updatedAt: recent,
    stateChangedAt: recent,
    completedAt: recent,
    ...extra,
  });
  writeFileSync(
    path.join(stateDir, "tasks.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        task("costly-parent", "Costly parent"),
        task("cheap-child", "Cheap child", { parentTaskId: "costly-parent" }),
        task("small-task", 'Polish, tidy "docs"'),
        task("tiny-task", "Tiny task"),
        task("custom-task", "Custom agent task", { harness: "my-cli" }),
        task("archived-task", "Archived big task", {
          createdAt: old,
          updatedAt: old,
          stateChangedAt: old,
          completedAt: old,
          archivedAt: old,
        }),
        ...bulkSessions.map((_, index) =>
          task(bulkId(index), `Bulk task ${String(index).padStart(2, "0")}`),
        ),
        task("waiting-task", "Waiting task", {
          state: "working",
          completedAt: undefined,
        }),
      ],
    }),
  );
  const binding = (taskId: string, sessionPath: string) => ({
    id: `binding-${taskId}`,
    taskId,
    sessionPath,
    detached: false,
    createdAt: recent,
    updatedAt: recent,
  });
  writeFileSync(
    path.join(stateDir, "workspace-bindings.json"),
    JSON.stringify({
      version: 1,
      bindings: [
        binding("costly-parent", parentSession),
        binding("cheap-child", childSession),
        binding("small-task", smallSession),
        binding("tiny-task", tinySession),
        binding("archived-task", archivedSession),
        ...bulkSessions.map((file, index) => binding(bulkId(index), file)),
        binding("waiting-task", waitingSession),
      ],
    }),
  );

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: writeShellPi(root),
      HARBORMASTER_E2E_SAVE_PATH: savePath,
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

test("the Costs page ranks tasks by tokens, filters by range and groups rows", async () => {
  await window.getByTestId("costs-button").click();
  const view = window.getByTestId("costs-view");
  await expect(view).toBeVisible();

  // This week (default): everything but the 60-day-old archived task;
  // the custom agent has no usage reader, so its row is n/a, never 0.
  // Every one of the 45 counted tasks is there well before the next 30s
  // refresh tick; the waiting task (transcript not written yet) is not a
  // row but is still being counted.
  const rows = view.getByTestId("costs-row");
  const totalsLine = view.getByTestId("costs-totals");
  await expect(rows).toHaveCount(5 + BULK, { timeout: 15_000 });
  await expect(totalsLine).toHaveText(
    "45 tasks · 1.5M tokens · ~$4.27 est. · counting 1 more…",
  );
  await expect(totalsLine).toHaveAttribute(
    "title",
    "own usage per task; subtasks counted once",
  );
  await expect(view.locator('[data-task-id="waiting-task"]')).toHaveCount(0);
  for (let index = 0; index < BULK; index += 1) {
    await expect(view.locator(`[data-task-id="${bulkId(index)}"]`)).toHaveCount(
      1,
    );
  }

  // The transcript shows up; the next refresh counts it and the hint goes.
  writePiUsageSession(waitingSession, "ffffffff-waiting", [opus(bulkTokens())]);
  await window.evaluate(() => window.harbormaster.core.refresh());
  await expect(totalsLine).toHaveText("46 tasks · 1.5M tokens · ~$4.27 est.");
  await expect(view.getByTestId("costs-counting")).toHaveCount(0);
  await expect(rows).toHaveCount(6 + BULK);

  // The parent ranks on its total incl. its subtask, own muted beside it.
  await expect(rows.first()).toHaveAttribute("data-task-id", "costly-parent");
  await expect(rows.first().getByTestId("costs-row-tokens")).toHaveText(
    "1.5M · own 1.2M",
  );
  await expect(rows.first().getByTestId("costs-row-cost")).toHaveText(
    "~$4.25 · own ~$3.50",
  );
  await expect(rows.first().getByTestId("costs-row-subtasks")).toHaveText(
    "⤷ 1 subtask",
  );

  // The search box narrows the rows (totals too); Esc in it clears it and
  // stays on the page.
  const search = view.getByTestId("costs-search");
  await search.fill("TIDY");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-task-id", "small-task");
  await expect(totalsLine).toHaveText(/^1 task · /);
  await search.fill("no such task anywhere");
  await expect(rows).toHaveCount(0);
  await expect(totalsLine).toHaveText(/^0 tasks · /);
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(view).toBeVisible();
  await expect(rows).toHaveCount(6 + BULK);
  const custom = view.locator('[data-task-id="custom-task"]');
  await expect(custom.getByTestId("costs-row-tokens")).toHaveText("n/a");
  await expect(custom.getByTestId("costs-row-cost")).toHaveText("—");

  // All: archived tasks count too (the range is a filter, not retention).
  await view.getByTestId("costs-filter-range").click();
  await window
    .getByTestId("costs-filter-range-option")
    .filter({ hasText: "All" })
    .click();
  await expect(rows).toHaveCount(7 + BULK);
  await expect(rows.first()).toHaveAttribute("data-task-id", "archived-task");

  // Model filter, from the rows' own models.
  await view.getByTestId("costs-filter-model").click();
  await window
    .getByTestId("costs-filter-model-option")
    .filter({ hasText: "gpt-5" })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-task-id", "cheap-child");
  await view.getByTestId("costs-filter-model").click();
  await window
    .getByTestId("costs-filter-model-option")
    .filter({ hasText: /^All$/ })
    .click();
  await expect(rows).toHaveCount(7 + BULK);

  // Group by model aggregates the same rows client-side.
  await view.getByTestId("costs-group-model").click();
  const groups = view.getByTestId("costs-group-row");
  await expect(groups).toHaveCount(3);
  await expect(groups.first()).toHaveAttribute("data-key", "claude-haiku-4-5");
  await expect(view.locator('[data-key="claude-opus-4-5"]')).toContainText(
    "1.2M",
  );
  await view.getByTestId("costs-group-harness").click();
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveAttribute("data-key", "pi");

  // A task row opens that task's workspace, like its card.
  await view.getByTestId("costs-group-task").click();
  await expect(window.getByTestId("sidebar-task-row-cheap-child")).toHaveCount(
    0,
  );
  await view.locator('[data-task-id="cheap-child"]').click();
  await expect(view).toHaveCount(0);
  // (the rail lists only opened tasks; nothing had opened this one)
  await expect(
    window.getByTestId("sidebar-task-row-cheap-child"),
  ).toBeVisible();

  // Esc leaves the page for the view it was opened from.
  await window.getByTestId("costs-button").click();
  await expect(view).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
});

test("Export CSV saves the table's rows through main", async () => {
  await window.getByTestId("costs-button").click();
  const view = window.getByTestId("costs-view");
  await expect(view.getByTestId("costs-row")).toHaveCount(6 + BULK, {
    timeout: 20_000,
  });
  await view.getByTestId("costs-export-csv").click();
  await expect.poll(() => existsSync(savePath)).toBe(true);
  const lines = readFileSync(savePath, "utf8").split("\r\n");
  expect(lines[0]).toBe(
    "taskId,title,repository,harness,state,completedAt,models,input,output,cacheRead,cacheWrite,totalTokens,turns,cost,costSource,subtaskCount,subtaskTokens",
  );
  // Same rows, same order as the table; raw numbers, RFC 4180 quoting.
  expect(lines.slice(1, -1).map((line) => line.split(",")[0])).toEqual([
    "costly-parent",
    "cheap-child",
    "small-task",
    "tiny-task",
    ...Array.from({ length: BULK }, (_, index) => bulkId(index)),
    "waiting-task",
    "custom-task",
  ]);
  expect(lines[1]).toMatch(
    /^costly-parent,Costly parent,,pi,done,[^,]+,claude-opus-4-5,150000,30000,1000000,20000,1200000,2,3\.5,pi,1,300000$/,
  );
  expect(lines[3]).toMatch(/^small-task,"Polish, tidy ""docs""",/);
  expect(lines.at(-2)).toMatch(/^custom-task,Custom agent task,,my-cli,done,/);
  expect(lines.at(-1)).toBe("");
  await window.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
});

test("Costs columns resize by dragging a header edge and keep their width across a reload", async () => {
  const openCosts = async (): Promise<Locator> => {
    await window.getByTestId("costs-button").click();
    const view = window.getByTestId("costs-view");
    await expect(view.getByTestId("costs-row")).toHaveCount(6 + BULK, {
      timeout: 20_000,
    });
    return view;
  };
  const width = async (locator: Locator): Promise<number> =>
    (await locator.boundingBox())?.width ?? 0;

  let view = await openCosts();
  const taskHeader = view.getByTestId("costs-th-task");
  const before = await width(taskHeader);
  expect(before).toBeGreaterThan(100);
  const handle = view.getByTestId("costs-col-resize-task");
  const box = await handle.boundingBox();
  if (!box) throw new Error("no Task resize handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + 60, y, { steps: 4 });
  await window.mouse.move(x + 120, y, { steps: 4 });
  await window.mouse.up();
  await expect.poll(() => width(taskHeader)).toBeCloseTo(before + 120, -1);
  const resized = await width(taskHeader);
  expect(
    JSON.parse(
      (await window.evaluate(() =>
        window.localStorage.getItem("harbormaster.costs.columns"),
      )) ?? "null",
    ),
  ).toEqual({ v: 1, widths: { task: Math.round(resized) } });

  // A fresh renderer reads the width back.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  view = await openCosts();
  await expect
    .poll(() => width(view.getByTestId("costs-th-task")))
    .toBeCloseTo(resized, 0);
  await window.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
});

test("the workspace usage chip opens a breakdown and recounts on refresh; top cards show their usage", async () => {
  await window.getByTestId("board-button").click();
  // The three most expensive cards on the board always show their usage
  // line; the rest only on hover.
  const parentLine =
    cardLocator("Costly parent").getByTestId("card-usage-line");
  await expect(parentLine).toHaveAttribute("data-pinned", "true");
  await expect(parentLine).toHaveText("◔ 1.2M tok · ~$3.50");
  await expect(
    cardLocator("Polish, tidy").getByTestId("card-usage-line"),
  ).toHaveAttribute("data-pinned", "true");
  const tinyLine = cardLocator("Tiny task").getByTestId("card-usage-line");
  await expect(tinyLine).toHaveAttribute("data-pinned", "false");
  await expect(tinyLine).toBeHidden();
  await cardLocator("Tiny task").hover();
  await expect(tinyLine).toBeVisible();

  await cardLocator("Costly parent").click();
  const chip = window.locator('[data-testid="task-usage-chip"]:visible');
  await expect(chip).toContainText("1.2M tok · ~$3.50");
  await chip.click();
  const popover = window.getByTestId("task-usage-popover");
  await expect(popover.getByTestId("task-usage-total")).toContainText(
    "150k input · 30k output · 1.0M cache read · 20k cache write",
  );
  await expect(popover.getByTestId("task-usage-cost")).toContainText("~$3.50");
  await expect(popover.getByTestId("task-usage-cost")).toContainText(
    "est. by Pi at list price · not your bill",
  );
  await expect(popover.getByTestId("task-usage-models")).toContainText(
    "claude-opus-4-5",
  );
  await expect(popover.getByTestId("task-usage-models")).toContainText(
    "2 turns",
  );
  await expect(popover.getByTestId("task-usage-sessions")).toContainText("pi");
  await expect(popover.getByTestId("task-usage-sessions")).toContainText(
    "aaaaaaaa",
  );
  await expect(popover.getByTestId("task-usage-subtasks")).toHaveText(
    /Incl\. 1 subtask\s*300k tok · ~\$0\.75/,
  );

  // The agent keeps working: refresh recounts from the transcript.
  appendFileSync(
    parentSession,
    `${piUsageEntry(
      opus({
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 1,
      }),
      new Date().toISOString(),
    )}\n`,
  );
  await popover.getByTestId("task-usage-refresh").click();
  await expect(chip).toContainText("2.2M tok · ~$4.50");
  await expect(popover.getByTestId("task-usage-models")).toContainText(
    "3 turns",
  );
});
