// Sidebar fixed order + drag-and-drop reorder (/docs/design-decisions.md "sidebar rail order",
// R30). One fixture/launch, real pointer drags through dnd-kit's
// PointerSensor, condition waits only. Fixture: two repo groups
// (alpha-fixture: Alpha One [+ children Kid Red, Kid Blue], Alpha Two,
// Alpha Three; beta-fixture: Beta One, Beta Two), all opened workspaces.
//
// Every drag helper asserts the drag *actually started* (the portaled
// DragOverlay exists) before moving to the drop target, so a drag that never
// crossed the 4px activation distance cannot make a "nothing changed"
// assertion pass vacuously.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionPresenceAccess } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { chooseWhere } from "./composer";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

const ALPHA = "alpha-fixture";
const BETA = "beta-fixture";
const TASK_ORDER_KEY = "harbormaster.sidebar.taskOrder";
const GROUP_ORDER_KEY = "harbormaster.sidebar.groupOrder";
const DETACHED_KEY = "harbormaster.sidebar.detachedChildIds";
const COLLAPSED_GROUPS_KEY = "harbormaster.sidebar.collapsedGroups";
const COLLAPSED_PARENTS_KEY = "harbormaster.lineage.collapsedParents";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

function initRepo(checkout: string, remote: string): void {
  git(["init", "-q", "-b", "main", checkout], path.dirname(checkout));
  git(
    [
      "-c",
      "user.name=Harbormaster E2E",
      "-c",
      "user.email=harbormaster-e2e@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    checkout,
  );
  git(["remote", "add", "origin", remote], checkout);
}

/** The sidebar row whose own title element is exactly `title` (children carry a "↳ parent" line that would fool hasText). */
function row(window: Page, title: string): Locator {
  return window.locator('[data-testid^="sidebar-task-row-"]').filter({
    has: window
      .getByTestId("sidebar-row-title")
      .getByText(title, { exact: true }),
  });
}

async function rowId(target: Locator): Promise<string> {
  const testId = await target.getAttribute("data-testid");
  if (!testId) throw new Error("row without data-testid");
  return testId.replace("sidebar-task-row-", "");
}

/** Row titles of one repo group, top to bottom. */
function groupTitles(window: Page, label: string): Promise<string[]> {
  return window
    .getByTestId(`sidebar-group-${label}`)
    .getByTestId("sidebar-row-title")
    .allInnerTexts();
}

/** Repo group labels, top to bottom. */
async function groupLabels(window: Page): Promise<string[]> {
  const ids = await window
    .locator('[data-testid^="sidebar-group-toggle-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid") ?? ""),
    );
  return ids.map((id) => id.replace("sidebar-group-toggle-", ""));
}

function storageValue(window: Page, key: string): Promise<string | null> {
  return window.evaluate((k) => window.localStorage.getItem(k), key);
}

async function storageList(window: Page, key: string): Promise<string[]> {
  const raw = await storageValue(window, key);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

async function nextFrames(window: Page): Promise<void> {
  await window.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

const overlay = (window: Page): Locator =>
  window.locator(
    '[data-testid="sidebar-drag-overlay-row"], [data-testid="sidebar-drag-overlay-group"]',
  );

interface Drag {
  /** Pointer position of the next move target relative to a locator's centre. */
  moveOver(target: Locator, dx?: number): Promise<void>;
  /** Releases the pointer and waits for the drag to end. */
  drop(): Promise<void>;
}

/**
 * dnd-kit's PointerSensor swallows every click for 50ms after a drop: on
 * activation it adds a capture-phase `click` listener on the document that
 * stops propagation, and on detach removes it only after
 * `setTimeout(…, 50)` (AbstractPointerSensor.detach). A click inside that
 * window never reaches React, so an automated click right after a drop
 * (no human is that fast) silently does nothing. Wait until a probe click
 * on <body> propagates again.
 */
async function clickGuardReleased(window: Page): Promise<void> {
  await expect
    .poll(() =>
      window.evaluate(() => {
        let reached = false;
        const probe = (): void => {
          reached = true;
        };
        document.body.addEventListener("click", probe);
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        document.body.removeEventListener("click", probe);
        return reached;
      }),
    )
    .toBe(true);
}

/**
 * Presses on `source`, moves past the 4px activation distance, and waits for
 * the DragOverlay: proof a real drag started. Targets must be resolved *after*
 * this returns, since rows hide/collapse at drag start.
 */
async function beginDrag(window: Page, source: Locator): Promise<Drag> {
  const box = await source.boundingBox();
  if (!box) throw new Error("drag source not visible");
  const startX = box.x + box.width * 0.4;
  const startY = box.y + box.height / 2;
  await window.mouse.move(startX, startY);
  await window.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await window.mouse.move(startX + i * 3, startY + i * 3);
  }
  await expect(overlay(window)).toBeVisible();
  // The drag-only layout (hidden blocks / collapsed bodies) is applied a frame
  // after the drag starts; targets must be resolved against it.
  await expect(window.getByTestId("sidebar-list")).toHaveAttribute(
    "data-drag-layout",
    /task|group/,
  );
  await nextFrames(window);
  let x = startX + 12;
  let y = startY + 12;
  return {
    async moveOver(target: Locator, dx = 0): Promise<void> {
      const targetBox = await target.boundingBox();
      if (!targetBox) throw new Error("drop target not visible");
      const endX = targetBox.x + targetBox.width * 0.4 + dx;
      const endY = targetBox.y + targetBox.height / 2;
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await window.mouse.move(
          x + ((endX - x) * i) / steps,
          y + ((endY - y) * i) / steps,
        );
      }
      x = endX;
      y = endY;
      await nextFrames(window);
      // R22: the portaled preview stays under the pointer even though rows
      // hid at drag start (it must never drift by the removed height).
      await expect
        .poll(async () => {
          const box = await overlay(window).boundingBox();
          return !!box && box.y <= endY + 1 && endY - 1 <= box.y + box.height;
        })
        .toBe(true);
    },
    async drop(): Promise<void> {
      await window.mouse.up();
      await expect(overlay(window)).toHaveCount(0);
      await nextFrames(window);
      await clickGuardReleased(window);
    },
  };
}

async function createRepoTask(
  window: Page,
  title: string,
  repositoryId: string,
): Promise<void> {
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill(title);
  await chooseWhere(window, repositoryId);
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  await expect(row(window, title)).toBeVisible();
}

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-reorder-"));
  stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  initRepo(path.join(codeRoot, ALPHA), `https://github.com/test/${ALPHA}.git`);
  initRepo(path.join(codeRoot, BETA), `https://github.com/test/${BETA}.git`);
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: true, codeRoot, branchPrefix: "" }),
  );
  // Fake pi that exits at once: no real agent runs, and with no live pane of
  // ours the test's own presence records (written below) are trusted as-is.
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
  chmodSync(fakePi, 0o755);

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: fakePi,
      HARBORMASTER_PRESENCE_POLL_MS: "250",
    },
  });
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) mainProcessErrors.push(text);
  };
  app.process().stdout?.on("data", onChunk);
  app.process().stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  // The whole fixture rail must fit without scrolling: a drop target at the
  // list's bottom edge would trigger dnd-kit's edge auto-scroll mid-drag and
  // move the rows out from under the pointer, confounding every drop.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 1000);
  });
  await expect
    .poll(() => window.evaluate(() => innerHeight))
    .toBeGreaterThan(900);

  const alphaId = `github.com/test/${ALPHA}`;
  const betaId = `github.com/test/${BETA}`;
  // A started draft lands at the TOP of the rail (where its draft row was),
  // so create bottom-first to get the intended top-to-bottom initial order.
  await createRepoTask(window, "Alpha Three", alphaId);
  await createRepoTask(window, "Alpha Two", alphaId);
  await createRepoTask(window, "Alpha One", alphaId);
  await createRepoTask(window, "Beta Two", betaId);
  await createRepoTask(window, "Beta One", betaId);

  // Two children of Alpha One, launched through the real launch primitive,
  // then opened from their board cards so they get rail rows.
  const parentId = await rowId(row(window, "Alpha One"));
  for (const title of ["Kid Red", "Kid Blue"]) {
    await window.evaluate(
      async ({ fromTaskId, kidTitle, repositoryId }) => {
        const api = (
          globalThis as unknown as {
            harbormaster: {
              core: {
                launchTask(input: unknown): Promise<unknown>;
              };
            };
          }
        ).harbormaster.core;
        await api.launchTask({
          relation: "child",
          fromTaskId,
          title: kidTitle,
          prompt: "child work",
          repository: { repositoryId },
        });
      },
      { fromTaskId: parentId, kidTitle: title, repositoryId: alphaId },
    );
    await window.getByTestId("board-button").click();
    const card = window
      .locator('[data-testid^="card-"]')
      .filter({ hasText: title });
    await expect(card).toBeVisible();
    await card.click();
    await expect(row(window, title)).toBeVisible();
  }
});

test.afterAll(async () => {
  await app.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

const ALPHA_INITIAL = [
  "Alpha One",
  "Kid Red",
  "Kid Blue",
  "Alpha Two",
  "Alpha Three",
];

test("a presence change or column move never reorders the rail", async () => {
  expect(await groupTitles(window, ALPHA)).toEqual(ALPHA_INITIAL);
  expect(await groupTitles(window, BETA)).toEqual(["Beta One", "Beta Two"]);

  // A running turn on the last alpha row (the old activity sort floated it
  // to the top of its group)…
  const lastId = await rowId(row(window, "Alpha Three"));
  const presence = new SessionPresenceAccess(path.join(stateDir, "presence"));
  await presence.register({
    taskId: lastId,
    sessionPath: "/tmp/fake-session-reorder.jsonl",
    pid: process.pid,
    mode: "interactive",
    at: new Date().toISOString(),
  });
  await presence.setTurnActive(
    lastId,
    process.pid,
    true,
    new Date().toISOString(),
  );
  await expect(
    row(window, "Alpha Three").getByTestId("sidebar-row-spinner"),
  ).toBeVisible({ timeout: 10_000 });

  // …and a column move of the last beta row (board order puts Backlog first).
  const betaTwoId = await rowId(row(window, "Beta Two"));
  await window.evaluate(async (id) => {
    await (
      globalThis as unknown as {
        harbormaster: {
          core: { moveTask(id: string, state: string): Promise<unknown> };
        };
      }
    ).harbormaster.core.moveTask(id, "backlog");
  }, betaTwoId);
  await expect(row(window, "Beta Two").getByTestId("state-chip")).toHaveText(
    "Backlog",
  );

  expect(await groupTitles(window, ALPHA)).toEqual(ALPHA_INITIAL);
  expect(await groupTitles(window, BETA)).toEqual(["Beta One", "Beta Two"]);

  await presence.setTurnActive(
    lastId,
    process.pid,
    false,
    new Date().toISOString(),
  );
});

test("dragging a row reorders it within its group and survives a reload", async () => {
  const drag = await beginDrag(window, row(window, "Alpha Three"));
  // R10/R15: while a top-level row is dragged, every nested block is hidden.
  await expect(row(window, "Kid Red")).toHaveCount(0);
  await expect(row(window, "Kid Blue")).toHaveCount(0);
  await drag.moveOver(row(window, "Alpha Two"));
  await drag.drop();

  const expected = [
    "Alpha One",
    "Kid Red",
    "Kid Blue",
    "Alpha Three",
    "Alpha Two",
  ];
  await expect.poll(() => groupTitles(window, ALPHA)).toEqual(expected);
  expect(await groupTitles(window, BETA)).toEqual(["Beta One", "Beta Two"]);
  // The hidden children reappear nested under their parent after the drop.
  await expect(row(window, "Kid Red")).toBeVisible();
  await expect
    .poll(async () => (await storageList(window, TASK_ORDER_KEY)).length)
    .toBeGreaterThan(0);

  await window.reload();
  await expect(row(window, "Alpha Two")).toBeVisible();
  await expect(row(window, "Kid Blue")).toBeVisible();
  await expect.poll(() => groupTitles(window, ALPHA)).toEqual(expected);
});

test("dropping a row onto another repo group does nothing", async () => {
  const orderBefore = await storageValue(window, TASK_ORDER_KEY);
  const alphaBefore = await groupTitles(window, ALPHA);
  const betaBefore = await groupTitles(window, BETA);

  // Alpha Three is not the last alpha row, so a drop that wrongly snapped to
  // the nearest alpha row (the bottom one) would visibly reorder it.
  const drag = await beginDrag(window, row(window, "Alpha Three"));
  await drag.moveOver(row(window, "Beta One"));
  await drag.drop();

  expect(await groupTitles(window, ALPHA)).toEqual(alphaBefore);
  expect(await groupTitles(window, BETA)).toEqual(betaBefore);
  expect(await storageValue(window, TASK_ORDER_KEY)).toBe(orderBefore);
});

test("dragging a group header reorders the groups; bodies collapse only while dragging", async () => {
  expect(await groupLabels(window)).toEqual([ALPHA, BETA]);
  const collapsedBefore = await storageValue(window, COLLAPSED_GROUPS_KEY);

  const drag = await beginDrag(
    window,
    window.getByTestId(`sidebar-group-toggle-${BETA}`),
  );
  // R18: every body renders collapsed mid-drag (headers only)…
  await expect(
    window.getByTestId(`sidebar-group-toggle-${ALPHA}`),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    window
      .getByTestId(`sidebar-group-${ALPHA}`)
      .getByTestId("sidebar-row-title"),
  ).toHaveCount(0);
  await drag.moveOver(window.getByTestId(`sidebar-group-toggle-${ALPHA}`));
  await drag.drop();

  await expect.poll(() => groupLabels(window)).toEqual([BETA, ALPHA]);
  // …and are restored afterwards, with the saved collapse state untouched.
  await expect(
    window.getByTestId(`sidebar-group-toggle-${ALPHA}`),
  ).toHaveAttribute("aria-expanded", "true");
  expect(await groupTitles(window, ALPHA)).toEqual([
    "Alpha One",
    "Kid Red",
    "Kid Blue",
    "Alpha Three",
    "Alpha Two",
  ]);
  expect(await storageValue(window, COLLAPSED_GROUPS_KEY)).toBe(
    collapsedBefore,
  );
  expect(await storageList(window, GROUP_ORDER_KEY)).toEqual([BETA, ALPHA]);
});

test("a nested child dragged out of its parent's block detaches; dragged back it re-attaches (and expands a collapsed parent)", async () => {
  const redId = await rowId(row(window, "Kid Red"));
  const parentId = await rowId(row(window, "Alpha One"));
  const isNested = (title: string): Promise<boolean> =>
    row(window, title).evaluate(
      (el) => el.parentElement?.classList.contains("ml-3") ?? false,
    );
  expect(await isNested("Kid Red")).toBe(true);
  await expect(
    row(window, "Kid Red").getByTestId("sidebar-row-lineage-line"),
  ).toHaveCount(0);

  // Detach: drop below the last top-level row of the group.
  let drag = await beginDrag(window, row(window, "Kid Red"));
  await drag.moveOver(row(window, "Alpha Two"));
  // R14: the in-flow placeholder already shows the projected (detached) indent.
  await expect.poll(() => isNested("Kid Red")).toBe(false);
  await drag.drop();

  await expect
    .poll(() => groupTitles(window, ALPHA))
    .toEqual(["Alpha One", "Kid Blue", "Alpha Three", "Alpha Two", "Kid Red"]);
  await expect(
    row(window, "Kid Red").getByTestId("sidebar-row-lineage-line"),
  ).toHaveText("↳ Alpha One");
  expect(await isNested("Kid Red")).toBe(false);
  await expect.poll(() => storageList(window, DETACHED_KEY)).toContain(redId);

  // Collapse the parent's children, then drag Kid Red back into its block.
  // A click fired right after a dnd-kit drop can be swallowed (drop timing),
  // so retry idempotently: click only while still expanded, until collapsed.
  const lineageToggle = window.getByTestId(
    `sidebar-row-lineage-toggle-${parentId}`,
  );
  await expect(async () => {
    if ((await lineageToggle.getAttribute("aria-expanded")) === "true") {
      await lineageToggle.click();
    }
    await expect(row(window, "Kid Blue")).toHaveCount(0, { timeout: 1000 });
  }).toPass();
  const collapsedBefore = await storageValue(window, COLLAPSED_PARENTS_KEY);

  drag = await beginDrag(window, row(window, "Kid Red"));
  // R15: the dragged child's own parent's block is shown even though collapsed
  // (a drag-only override; the saved collapse state is untouched).
  await expect(row(window, "Kid Blue")).toBeVisible();
  expect(await storageValue(window, COLLAPSED_PARENTS_KEY)).toBe(
    collapsedBefore,
  );
  await drag.moveOver(row(window, "Kid Blue"));
  await expect.poll(() => isNested("Kid Red")).toBe(true);
  await drag.drop();

  await expect
    .poll(() => groupTitles(window, ALPHA))
    .toEqual(["Alpha One", "Kid Red", "Kid Blue", "Alpha Three", "Alpha Two"]);
  await expect(
    row(window, "Kid Red").getByTestId("sidebar-row-lineage-line"),
  ).toHaveCount(0);
  expect(await isNested("Kid Red")).toBe(true);
  await expect(
    window.getByTestId(`sidebar-row-lineage-toggle-${parentId}`),
  ).toHaveAttribute("aria-expanded", "true");
  expect(await storageList(window, DETACHED_KEY)).not.toContain(redId);
});

test("a plain click selects a row, a drag does not; close + reopen lands at the bottom", async () => {
  const betaOne = row(window, "Beta One");
  await betaOne.click();
  await expect(betaOne).toHaveAttribute("data-selected", "true");
  expect(await overlay(window).count()).toBe(0);

  // A real drag (overlay proves it started) that is dropped where it started
  // neither selects the dragged row, nor changes selection, nor writes order.
  const orderBefore = await storageValue(window, TASK_ORDER_KEY);
  const alphaTwo = row(window, "Alpha Two");
  const drag = await beginDrag(window, alphaTwo);
  await drag.moveOver(alphaTwo);
  await drag.drop();
  await expect(alphaTwo).not.toHaveAttribute("data-selected", "true");
  await expect(betaOne).toHaveAttribute("data-selected", "true");
  expect(await storageValue(window, TASK_ORDER_KEY)).toBe(orderBefore);

  // The close button still works on a drag-capable row, and reopening the
  // task appends it at the bottom of its group (not its old slot).
  await betaOne.hover();
  await betaOne.getByTestId("sidebar-row-close").click();
  await expect(row(window, "Beta One")).toHaveCount(0);
  expect(await groupTitles(window, BETA)).toEqual(["Beta Two"]);
  await window.getByTestId("board-button").click();
  const card = window
    .locator('[data-testid^="card-"]')
    .filter({ hasText: "Beta One" });
  await expect(card).toBeVisible();
  await card.click();
  await expect(row(window, "Beta One")).toBeVisible();
  await expect
    .poll(() => groupTitles(window, BETA))
    .toEqual(["Beta Two", "Beta One"]);
});

test("lineage wins over repo: a cross-repo child nests under its parent's repo group, with its own repo chip", async () => {
  const parentId = await rowId(row(window, "Alpha One"));
  const alphaBefore = await groupTitles(window, ALPHA);
  const betaBefore = await groupTitles(window, BETA);
  // A child of Alpha One that lives in the *beta* repository.
  await window.evaluate(
    async ({ fromTaskId, repositoryId }) => {
      await (
        globalThis as unknown as {
          harbormaster: {
            core: { launchTask(input: unknown): Promise<unknown> };
          };
        }
      ).harbormaster.core.launchTask({
        relation: "child",
        fromTaskId,
        title: "Kid Beta",
        prompt: "child work in another repo",
        repository: { repositoryId },
      });
    },
    { fromTaskId: parentId, repositoryId: `github.com/test/${BETA}` },
  );

  // Board: same column as its parent, so it sits in the parent's (alpha)
  // repo group, nested, and the beta group never shows it.
  await window.getByTestId("board-button").click();
  const card = window
    .locator('[data-testid^="card-"]')
    .filter({ hasText: "Kid Beta" });
  const alphaDev = window.getByTestId(`group-dev-github.com/test/${ALPHA}`);
  await expect(alphaDev.filter({ has: card })).toBeVisible();
  await expect(card.getByTestId("card-repo-chip")).toHaveText(BETA);
  await expect(card.getByTestId("card-lineage-line")).toHaveCount(0);

  // Rail: once open, it nests in the alpha group under Alpha One; counts are
  // the rows shown under each header.
  await card.click();
  await expect(row(window, "Kid Beta")).toBeVisible();
  const kids = alphaBefore.filter((title) => title.startsWith("Kid "));
  const rest = alphaBefore.filter(
    (title) => title !== "Alpha One" && !title.startsWith("Kid "),
  );
  await expect
    .poll(() => groupTitles(window, ALPHA))
    .toEqual(["Alpha One", ...kids, "Kid Beta", ...rest]);
  expect(await groupTitles(window, BETA)).toEqual(betaBefore);
  await expect(
    window
      .getByTestId(`sidebar-group-${ALPHA}`)
      .getByTestId("sidebar-group-count"),
  ).toHaveText(String(alphaBefore.length + 1));
  await expect(
    window
      .getByTestId(`sidebar-group-${BETA}`)
      .getByTestId("sidebar-group-count"),
  ).toHaveText(String(betaBefore.length));
  expect(
    await row(window, "Kid Beta").evaluate(
      (el) => el.parentElement?.classList.contains("ml-3") ?? false,
    ),
  ).toBe(true);
  await expect(
    row(window, "Kid Beta").getByTestId("sidebar-row-repo-chip"),
  ).toHaveText(BETA);
  await expect(
    row(window, "Alpha One").getByTestId("sidebar-row-repo-chip"),
  ).toHaveText(ALPHA);
});
