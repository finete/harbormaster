// Task-launching e2e lane (wave 3 / renderer UI + e2e, see
// /docs/design-decisions.md "Launching tasks from an agent" and the wave-3 task brief): the one integration
// seam the renderer's lineage/queued/attach UI actually depends on. Real
// @harbormaster/core + a real git fixture repo; `pi` and `gh` are tiny
// fakes (HARBORMASTER_PI_COMMAND / HARBORMASTER_GH_COMMAND), so nothing
// ever touches the network or a real GitHub account.
//
// `launch.maxConcurrent: 1` plus a "Blocker" standalone launch that starts
// immediately (and never reports presence, so it counts as "working" for
// the whole grace window — see background-launcher.ts's `isWorking`) keeps
// the task-under-test's launch deterministically `queued` until the test
// itself raises the cap and waits for the next presence-poll-driven
// background-launcher pass (`HARBORMASTER_PRESENCE_POLL_MS` sped up to
// 250ms) — no sleep-and-hope needed for the queued -> started edge.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const REPO_ID = "github.com/test/fixture";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd }).toString();
}

let app: ElectronApplication;
let window: Page;
let root: string;
let repoCheckout: string;
let configPath: string;
let invokeLogPath: string;
let mouseLogPath: string;
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

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

async function cardTaskId(card: Locator): Promise<string> {
  const testId = await card.getAttribute("data-testid");
  if (!testId) throw new Error("card missing data-testid");
  return testId.replace("card-", "");
}

function setMaxConcurrent(value: number): void {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  raw.launch = { ...(raw.launch ?? {}), maxConcurrent: value };
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
}

/** Lines the fake pi appended to its invocation log whose cwd contains `needle` (e.g. a task's branch slug). */
function invocationsFor(needle: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(invokeLogPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0 && line.includes(needle));
}

async function openLaunchComposer(relation: "subtask" | "task"): Promise<void> {
  // Launching lives inside the new-task draft composer (one entry point):
  // the draft captures the focused task as its origin; the link chip adds
  // the link (default relation: standalone) and picks the relation.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-link-add").click();
  if (relation === "subtask") {
    await window.getByTestId("new-task-link-child").click();
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-launch-"));
  const stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });

  repoCheckout = path.join(codeRoot, "fixture-repo");
  git(["init", "-q", "-b", "main", repoCheckout], root);
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
    repoCheckout,
  );
  git(
    ["remote", "add", "origin", "https://github.com/test/fixture.git"],
    repoCheckout,
  );

  configPath = path.join(stateDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      automation: true,
      codeRoot,
      branchPrefix: "",
      // Deterministically queued (see module doc): the one slot goes to the
      // "Blocker" standalone launch the first test starts.
      launch: { maxConcurrent: 1 },
    }),
  );

  invokeLogPath = path.join(root, "pi-invocations.log");
  mouseLogPath = path.join(root, "pi-mouse.log");

  // Fake pi: records its own invocation (cwd + pid) to a shared log file —
  // proof of exactly how many times pi actually started for a given
  // worktree — then idles so the pty stays alive. No session/presence file
  // is ever written (a real pi-session concern), which also means a
  // launched task's grace-window "working" status never expires within
  // this test's lifetime (see background-launcher.ts's `isWorking`).
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'printf "cwd:%s pid:%s\\n" "$PWD" "$$" >> "$PI_INVOKE_LOG"',
      // The child-under-test behaves like fullscreen pi: alt screen + mouse
      // tracking (?1002h) + SGR encoding (?1006h), logging every byte the
      // pane sends back so the test can inspect the mouse reports.
      'case "$PWD" in *child-under-test*)',
      "  stty raw -echo",
      "  printf '\\033[?1049h\\033[?1000h\\033[?1002h\\033[?1004h\\033[?1006h\\033[?25lchild-ready'",
      '  exec cat >> "$PI_MOUSE_LOG" ;;',
      "esac",
      "while true; do sleep 3600; done",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);

  const fakeGh = path.join(root, "fake-gh");
  writeFileSync(fakeGh, ["#!/bin/sh", "printf '[]'", ""].join("\n"));
  chmodSync(fakeGh, 0o755);

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: fakePi,
      HARBORMASTER_GH_COMMAND: fakeGh,
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      PI_INVOKE_LOG: invokeLogPath,
      PI_MOUSE_LOG: mouseLogPath,
    },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
});

test.afterEach(() => {
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
});

test.afterAll(async () => {
  await app.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("launching a subtask nests it under its parent, queued, starting in the background into the sidebar rail with no focus or view switch; opening it attaches with exactly one pi process", async () => {
  // --- Seed: a repo-backed parent task, started now (Dev + its own pi pane). ---
  await window.getByTestId("board-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Parent Task");
  await window.getByTestId("new-task-repo-select").selectOption(REPO_ID);
  await window
    .getByTestId("new-task-prompt-input")
    .fill("Coordinate the subtasks");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  // Creating lands in the workspace view (the new task focused); the card
  // lookups below are on the board.
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();

  const parentCard = cardLocator("Parent Task");
  await expect(
    window.getByTestId("column-dev-cards").filter({ has: parentCard }),
  ).toBeVisible();
  const parentId = await cardTaskId(parentCard);

  await parentCard.click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId(`task-actions-${parentId}`)).toBeVisible();

  // --- Consume the one concurrency slot with a standalone "Blocker" launch, ---
  // --- so the real task-under-test's launch stays queued, not racy.       ---
  await openLaunchComposer("task");
  await expect(window.getByTestId("new-task-link-standalone")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await window.getByTestId("new-task-title-input").fill("Blocker");
  await window
    .getByTestId("new-task-prompt-input")
    .fill("Occupy the only concurrency slot");
  // Repository: "None / scratch" (default) — a scratch task is enough to
  // occupy a launch slot and never touches the fixture repo's worktrees.
  await window.getByTestId("new-task-mode-chat").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  await expect(
    window.getByTestId("toast-success").filter({ hasText: "Blocker" }),
  ).toBeVisible();
  // Give the background launcher a moment to claim+start it (so it's the
  // one holding the slot, not our task-under-test, before that launches).
  await window.waitForTimeout(500);

  // --- The actual task-under-test: a child, same repo as its parent. ---
  await openLaunchComposer("subtask");
  await expect(window.getByTestId("new-task-link-child")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await window.getByTestId("new-task-title-input").fill("Child Under Test");
  await window
    .getByTestId("new-task-prompt-input")
    .fill("Fix the specific bug");
  await window.getByTestId("new-task-repo-select").selectOption(REPO_ID);
  // Same repo as the parent + parent has a branch: the base-branch picker
  // appears (wave-3 task brief item 5).
  await expect(window.getByTestId("new-task-base-branch")).toBeVisible();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  await expect(
    window.getByTestId("toast-success").filter({ hasText: "Child Under Test" }),
  ).toBeVisible();

  // Launching never steals focus/view (PRD): still the workspace view,
  // still focused on the parent, and the child's workspace never mounted.
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("board-view")).toBeHidden();

  // --- Nesting + the queued marker, on the board. ---
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();

  const childCard = cardLocator("Child Under Test");
  const childId = await cardTaskId(childCard);
  await expect(window.getByTestId(`task-workspace-${childId}`)).toHaveCount(0);

  const toggle = window.getByTestId(`lineage-children-toggle-${parentId}`);
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText("1 child");
  await expect(childCard).toBeVisible();
  await expect(childCard.getByTestId("badge-launch-queued")).toBeVisible();

  // Still queued: the fake pi was never invoked for the child's worktree.
  expect(invocationsFor("child-under-test")).toEqual([]);

  // --- Free up capacity; the background launcher starts it on the next ---
  // --- presence-poll pass (250ms), no manual refresh needed.            ---
  setMaxConcurrent(5);
  await expect(childCard.getByTestId("badge-launch-queued")).toHaveCount(0, {
    timeout: 10_000,
  });

  // Started in the background: exactly one pi process for it, and it was
  // auto-added to the sidebar rail (its workspace mounted, attached to that
  // pty) without stealing the view or focus from the parent.
  await expect
    .poll(() => invocationsFor("child-under-test").length, {
      timeout: 10_000,
    })
    .toBe(1);
  await expect(window.getByTestId(`sidebar-task-row-${childId}`)).toHaveCount(
    1,
    { timeout: 10_000 },
  );
  await expect(window.getByTestId(`task-workspace-${childId}`)).toHaveCount(1);
  await expect(window.getByTestId("board-view")).toBeVisible();
  await expect(
    window.getByTestId(`sidebar-task-row-${parentId}`),
  ).toHaveAttribute("data-selected", "true");
  await expect(
    window.getByTestId(`sidebar-task-row-${childId}`),
  ).not.toHaveAttribute("data-selected", "true");

  // --- Opening it attaches: no takeover dialog, no second pi process. ---
  await childCard.click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("takeover-dialog")).toHaveCount(0);
  await expect(
    window
      .getByTestId(`task-workspace-${childId}`)
      .getByTestId("terminal-panel"),
  ).toBeVisible();
  // Give any (incorrect) second-spawn path a moment to show up before
  // asserting the count stays at exactly one.
  await window.waitForTimeout(500);
  expect(invocationsFor("child-under-test")).toHaveLength(1);

  // --- The attached background primary must send SGR (1006) mouse reports: ---
  // --- addon-serialize drops the mouse encoding, so without the replayed  ---
  // --- modes xterm falls back to X10 and fullscreen pi sees no wheel/drag. ---
  const childPanel = window
    .getByTestId(`task-workspace-${childId}`)
    .getByTestId("terminal-panel");
  await expect(childPanel)
    .toContainText("child-ready", { timeout: 10_000 })
    .catch(() => {
      // Without the a11y mirror the text isn't in the DOM; the mouse log
      // below is the real assertion.
    });
  const readMouseLog = (): string => {
    try {
      return readFileSync(mouseLogPath, "binary");
    } catch {
      return "";
    }
  };
  const box = await childPanel.boundingBox();
  if (!box) throw new Error("child terminal panel has no bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await window.mouse.move(cx, cy);
  await expect
    .poll(
      async () => {
        await window.mouse.wheel(0, -100);
        return readMouseLog();
      },
      { timeout: 15_000, intervals: [200] },
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is required for SGR mouse
    .toMatch(/\x1b\[<6[45];\d+;\d+M/);
  await window.mouse.move(cx - 40, cy);
  await window.mouse.down();
  await window.mouse.move(cx + 40, cy, { steps: 5 });
  await window.mouse.up();
  await expect
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is required for SGR mouse
    .poll(() => /\x1b\[<0;\d+;\d+M/.test(readMouseLog()), { timeout: 5_000 })
    .toBe(true);

  // --- A window reload (dev full reload, Cmd+R) keeps the webContents, ---
  // --- so pane cleanup never runs: the reloaded panes must re-attach to  ---
  // --- the SAME pi instead of spawning a second one per task.           ---
  const parentInvocations = invocationsFor("parent-task").length;
  expect(parentInvocations).toBe(1);
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
  await window.getByTestId(`card-${childId}`).click();
  await expect(
    window
      .getByTestId(`task-workspace-${childId}`)
      .getByTestId("terminal-panel"),
  ).toBeVisible();
  await window.getByTestId("board-button").click();
  await window.getByTestId(`card-${parentId}`).click();
  await expect(
    window
      .getByTestId(`task-workspace-${parentId}`)
      .getByTestId("terminal-panel"),
  ).toBeVisible();
  await window.waitForTimeout(500);
  expect(invocationsFor("child-under-test")).toHaveLength(1);
  expect(invocationsFor("parent-task")).toHaveLength(1);

  // Outcome note: the fake pi never calls `harbormaster_report_status` (no
  // extension/MCP wiring in this fixture), so there is nothing to assert
  // here — the derivation itself is covered by
  // tests/task-status-lines.test.ts's `deriveOutcomeLine` cases.
});
