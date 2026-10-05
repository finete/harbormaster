// Wave 5b e2e lane: toReview/toDone/refresh wired end-to-end through the
// real @harbormaster/core command API. `HARBORMASTER_GH_COMMAND` (mirrors
// `HARBORMASTER_PI_COMMAND`, see packages/core/src/access
// /github-pr-access.ts) stands in a tiny fake `gh` CLI so these tests never
// touch the network or a real GitHub account. The fixture repo's `origin`
// is a local bare repo (file path) so `toReview`'s branch push succeeds
// offline, same as core's own git-backed tests.
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
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

// Same guard as the other e2e lanes: a main-process `uncaughtException` is a
// bug, not noise.
function watchForMainProcessErrors(
  electronApp: ElectronApplication,
  sink: string[],
): void {
  const child = electronApp.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) sink.push(text.trim());
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
}

function cardLocator(window: Page, title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

async function cardTaskId(card: Locator): Promise<string> {
  const testId = await card.getAttribute("data-testid");
  if (!testId) throw new Error("card missing data-testid");
  return testId.replace("card-", "");
}

/**
 * Seeds a tmp codeRoot with a git fixture repo whose `origin` is a local
 * bare repo (not a real GitHub URL): `toReview`'s `git push` needs a remote
 * that actually accepts a push offline.
 */
function seedFixtureRepoWithBareRemote(root: string, codeRoot: string): void {
  const barePath = path.join(root, "bare-origin.git");
  git(["init", "-q", "--bare", "-b", "main", barePath]);

  const repoCheckout = path.join(codeRoot, "fixture-repo");
  git(["init", "-q", "-b", "main", repoCheckout]);
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
  git(["remote", "add", "origin", barePath], repoCheckout);
  git(["push", "-q", "origin", "main"], repoCheckout);
}

/** A fake `gh` that answers `pr list`/`pr create` with a canned open PR, ignoring every other argument (repo id, branch, ...). */
function writeFakeGhSucceeding(root: string): string {
  const ghPath = path.join(root, "fake-gh");
  const prJson = JSON.stringify([
    {
      number: 42,
      url: "https://example.invalid/fixture/pull/42",
      state: "OPEN",
      isDraft: false,
      author: { login: "e2e" },
      reviewRequests: [],
      reviews: [],
      headRefOid: "abc1234",
      mergeCommit: null,
      baseRefName: "main",
    },
  ]).replace(/'/g, "'\\''");
  writeFileSync(
    ghPath,
    [
      "#!/bin/sh",
      'created_marker="$(dirname "$0")/pr-created"',
      'case "$1 $2" in',
      '  "pr list")',
      '    if [ -f "$created_marker" ]; then',
      `      printf '%s' '${prJson}'`,
      "    else",
      "      printf '[]'",
      "    fi",
      "    ;;",
      '  "pr create")',
      '    touch "$created_marker"',
      '    printf "https://example.invalid/fixture/pull/42\\n"',
      "    ;;",
      '  "pr ready")',
      "    ;;",
      "  *)",
      "    printf '[]'",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(ghPath, 0o755);
  return ghPath;
}

/** A fake `gh` that always fails, for the refresh-warning banner lane. */
function writeFakeGhFailing(root: string): string {
  const ghPath = path.join(root, "fake-gh-failing");
  writeFileSync(
    ghPath,
    ["#!/bin/sh", 'echo "fake gh: simulated failure" >&2', "exit 1", ""].join(
      "\n",
    ),
  );
  chmodSync(ghPath, 0o755);
  return ghPath;
}

test.describe("toReview and toDone drive the board through the real core command API", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-lifecycle-"));
    const stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepoWithBareRemote(root, codeRoot);
    const fakeGh = writeFakeGhSucceeding(root);
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        movers: [],
        codeRoot,
        branchPrefix: "",
      }),
    );

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_GH_COMMAND: fakeGh,
      },
    });
    watchForMainProcessErrors(app, mainProcessErrors);
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    await app.close();
    expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("creating a repo task then clicking To review pushes the branch, opens a PR, and moves the card into Awaiting / Review", async () => {
    await window.getByTestId("sidebar-new-task-button").click();
    await expect(window.getByTestId("new-task-dialog")).toBeVisible();
    await window.getByTestId("new-task-title-input").fill("Ship Feature");
    await window.getByTestId("new-task-repo-select").selectOption({ index: 1 });
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Ship Feature");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);

    // toReview requires a "dev" (or "awaiting") task; createTask always
    // lands new work in backlog (see NewTaskDialog.tsx) — move it forward
    // first, same as a user dragging the card over.
    await window.evaluate(
      (id) => window.harbormaster.core.moveTask(id, "dev"),
      taskId,
    );
    await expect(
      window
        .getByTestId("column-dev-cards")
        .locator(`[data-testid="card-${taskId}"]`),
    ).toBeVisible();

    const reviewButton = card.getByTestId(`to-review-button-${taskId}`);
    await expect(reviewButton).toBeEnabled();
    await reviewButton.click();

    const awaitingCard = window
      .getByTestId("column-awaiting-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(awaitingCard).toBeVisible({ timeout: 15_000 });
    await expect(awaitingCard.getByTestId("badge-pr")).toContainText("PR #42");
    await expect(
      window
        .getByTestId("column-awaiting-cards")
        .getByTestId("group-primary-label")
        .first(),
    ).toContainText("Review");
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });

  test("Done on a clean scratch task moves it straight to the Done column with no warning", async () => {
    // The previous test ended on the board view; back to the workspace view
    // for its sidebar "+ New task" button.
    await window.getByTestId("workspace-button").click();
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Quick Scratch Fix");
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Quick Scratch Fix");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);

    await window.evaluate(
      (id) => window.harbormaster.core.moveTask(id, "dev"),
      taskId,
    );
    await expect(
      window
        .getByTestId("column-dev-cards")
        .locator(`[data-testid="card-${taskId}"]`),
    ).toBeVisible();

    const doneButton = card.getByTestId(`to-done-button-${taskId}`);
    await expect(doneButton).toBeEnabled();
    await doneButton.click();

    const doneCard = window
      .getByTestId("column-done-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(doneCard).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("toast-warning")).toHaveCount(0);
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });
});

test.describe("the refresh loop surfaces a dismissible warning banner when gh fails", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-refresh-warn-"));
    const stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepoWithBareRemote(root, codeRoot);
    const fakeGh = writeFakeGhFailing(root);
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        movers: [],
        codeRoot,
        branchPrefix: "",
      }),
    );

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_GH_COMMAND: fakeGh,
      },
    });
    watchForMainProcessErrors(app, mainProcessErrors);
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    await app.close();
    expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a repo task with an open PR check fails gh, and the next refresh tick shows a warning toast", async () => {
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Flaky Gh Task");
    await window.getByTestId("new-task-repo-select").selectOption({ index: 1 });
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Flaky Gh Task");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);

    // refresh() only inspects dev/awaiting repo-backed tasks (see
    // CoreManager.refresh): move it out of backlog so the next tick's PR
    // status check actually calls the (failing) fake gh.
    await window.evaluate(
      (id) => window.harbormaster.core.moveTask(id, "dev"),
      taskId,
    );

    // Trigger a refresh deterministically instead of waiting out the app's
    // 30s automation timer (see main/index.ts's refreshOnce/startRefreshLoop)
    // — same command surface the timer itself calls.
    await window.evaluate(() => window.harbormaster.core.refresh());

    const warning = window.getByTestId("toast-warning");
    await expect(warning).toBeVisible({ timeout: 15_000 });
    await expect(warning).toContainText("Flaky Gh Task");

    // Electron's test viewport can report this fixed-position banner as
    // technically out of the visible viewport depending on window geometry
    // in CI; dispatch the click directly instead of relying on Playwright's
    // actionability (visible-in-viewport) check.
    await warning.getByTestId("toast-dismiss").dispatchEvent("click");
    await expect(warning).toHaveCount(0);
  });
});

test.describe("archived done tasks stay hidden until the Done column's toggle is used", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let stateDir: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-archive-"));
    stateDir = path.join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "archived-task-1",
            kind: "temp_task",
            state: "done",
            title: "Old Archived Task",
            initialPrompt: "",
            createdAt: now,
            updatedAt: now,
            stateChangedAt: now,
            completedAt: now,
            archivedAt: now,
          },
          {
            id: "visible-done-task-1",
            kind: "temp_task",
            state: "done",
            title: "Fresh Done Task",
            initialPrompt: "",
            createdAt: now,
            updatedAt: now,
            stateChangedAt: now,
            completedAt: now,
          },
        ],
      }),
    );

    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, HARBORMASTER_STATE_DIR: stateDir },
    });
    watchForMainProcessErrors(app, mainProcessErrors);
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    await app.close();
    expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("the archived task is hidden by default, shown after the toggle, and never in the sidebar", async () => {
    await window.getByTestId("board-button").click();

    await expect(cardLocator(window, "Fresh Done Task")).toBeVisible();
    await expect(cardLocator(window, "Old Archived Task")).toHaveCount(0);

    const toggle = window
      .getByTestId("column-done")
      .getByTestId("toggle-archived-button");
    await expect(toggle).toContainText("show archived (1)");

    await toggle.click();
    await expect(cardLocator(window, "Old Archived Task")).toBeVisible();
    await expect(toggle).toContainText("hide archived (1)");

    await window.getByTestId("workspace-button").click();
    await expect(window.getByTestId("workspace-view")).toBeVisible();
    await expect(
      window.locator('[data-testid^="sidebar-task-row-"]').filter({
        hasText: "Old Archived Task",
      }),
    ).toHaveCount(0);
    await expect(
      window.locator('[data-testid^="sidebar-task-row-"]').filter({
        hasText: "Fresh Done Task",
      }),
    ).toHaveCount(1);
  });
});
