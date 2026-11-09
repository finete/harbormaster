// Wave 5b e2e lane: toAwait/toDone/refresh wired end-to-end through the
// real @harbormaster/core command API. `HARBORMASTER_GH_COMMAND` (mirrors
// `HARBORMASTER_PI_COMMAND`, see packages/core/src/access
// /github-pr-access.ts) stands in a tiny fake `gh` CLI so these tests never
// touch the network or a real GitHub account. The fixture repo's `origin`
// is a local bare repo (file path) so the review kind's branch push succeeds
// offline, same as core's own git-backed tests.
import { execFileSync } from "node:child_process";
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
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { selectCard } from "./board-gestures";
import { chooseWhere, submitAs } from "./composer";
import { ghGraphqlShimLine } from "./fake-gh";
import { writeShellPi } from "./fake-pi";

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
 * Simulates a dnd-kit drag (same technique as smoke.spec.ts): real pointer
 * down/move/up, grabbing the card by its title strip so the press never
 * lands on the card's action buttons.
 */
async function dragTo(
  window: Page,
  card: Locator,
  target: Locator,
): Promise<void> {
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error("drag source/target not visible");
  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + 12;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;
  await window.mouse.move(startX, startY);
  await window.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await window.mouse.move(
      startX + (endX - startX) * t,
      startY + (endY - startY) * t,
    );
    await window.waitForTimeout(20);
  }
  await window.waitForTimeout(50);
  await window.mouse.up();
  await window.waitForTimeout(250);
}

/**
 * Seeds a tmp codeRoot with a git fixture repo whose `origin` is a local
 * bare repo (not a real GitHub URL): the review kind's `git push` needs a remote
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

/**
 * A fake `gh` that answers `pr list`/`pr create` with a canned open PR,
 * ignoring every other argument (repo id, branch, ...). `pr merge` flips
 * it to MERGED (with a merge commit) from then on, and every `pr merge`
 * argv is appended to `gh-merge.log` next to the script.
 */
function writeFakeGhSucceeding(root: string): string {
  const ghPath = path.join(root, "fake-gh");
  const prPayload = (merged: boolean): string =>
    JSON.stringify([
      {
        number: 42,
        url: "https://example.invalid/fixture/pull/42",
        state: merged ? "MERGED" : "OPEN",
        isDraft: false,
        author: { login: "e2e" },
        reviewRequests: [],
        reviews: [],
        headRefOid: "abc1234",
        mergeCommit: merged ? { oid: "fedcba9876543" } : null,
        baseRefName: "main",
      },
    ]).replace(/'/g, "'\\''");
  const prJson = prPayload(false);
  const mergedJson = prPayload(true);
  writeFileSync(
    ghPath,
    [
      "#!/bin/sh",
      // Who spawned this gh (see the spawn-host assertion below).
      'echo "$PPID" >> "$(dirname "$0")/gh-ppid.log"',
      ghGraphqlShimLine(root),
      'created_marker="$(dirname "$0")/pr-created"',
      'merged_marker="$(dirname "$0")/pr-merged"',
      'case "$1 $2" in',
      '  "pr list")',
      '    if [ -f "$merged_marker" ]; then',
      `      printf '%s' '${mergedJson}'`,
      '    elif [ -f "$created_marker" ]; then',
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
      '  "pr merge")',
      '    echo "$*" >> "$(dirname "$0")/gh-merge.log"',
      '    touch "$merged_marker"',
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

test.describe("toAwait and toDone drive the board through the real core command API", () => {
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
        codeRoot,
        branchPrefix: "",
      }),
    );

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
        HARBORMASTER_GH_COMMAND: fakeGh,
        HARBORMASTER_PI_COMMAND: writeShellPi(root),
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

  test("creating a repo task, then r on the board + Enter (the Await picker's review fast path) pushes the branch, opens a PR, and moves the card into Awaiting / Review", async () => {
    await window.getByTestId("sidebar-new-task-button").click();
    await expect(window.getByTestId("new-task-composer")).toBeVisible();
    await window.getByTestId("new-task-title-input").fill("Ship Feature");
    await chooseWhere(window, { index: 1 });
    await submitAs(window, "park");
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Ship Feature");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);
    // Cards carry no action buttons: the verbs are keys, drags, and the
    // workspace header.
    await expect(card.locator("button")).toHaveCount(0);
    // Every card shows a last-interaction time indicator (ported from
    // pi-home's withLastInteraction; see TaskCard.tsx).
    await expect(card.getByTestId("card-time")).not.toBeEmpty();

    // Await needs a "dev" (or "awaiting") task with a worktree; the task
    // was parked in Backlog above, so start it (creates the worktree and
    // moves it to dev), same as a user dragging the card over.
    await window.evaluate(
      (id) => window.harbormaster.core.startTask(id),
      taskId,
    );
    await expect(
      window
        .getByTestId("column-dev-cards")
        .locator(`[data-testid="card-${taskId}"]`),
    ).toBeVisible();

    await selectCard(window, taskId);
    await window.keyboard.press("r");
    const picker = window.getByTestId("await-picker");
    await expect(picker).toBeVisible();
    await expect(window.getByTestId("await-picker-kind-review")).toBeChecked();
    await expect(window.getByTestId("await-picker-notice")).toContainText(
      "Pushes",
    );
    await window.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);

    const awaitingCard = window
      .getByTestId("column-awaiting-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(awaitingCard).toBeVisible({ timeout: 15_000 });
    await expect(awaitingCard.getByTestId("badge-pr")).toContainText("PR #42");
    // Core's gh/git spawns run in the spawn host (a utility process child of
    // main), never on main's own event loop (src/main/spawn-host-client.ts).
    const mainPid = app.process().pid;
    const ghParents = [
      ...new Set(
        readFileSync(path.join(root, "gh-ppid.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(Number),
      ),
    ];
    expect(ghParents.length).toBeGreaterThan(0);
    expect(ghParents).not.toContain(mainPid);
    // The long-lived host is still running; short-lived parents (the
    // graphql shim) have exited and are skipped.
    const hostParents = ghParents.flatMap((pid) => {
      try {
        return [
          Number(
            execFileSync("ps", ["-o", "ppid=", "-p", String(pid)]).toString(),
          ),
        ];
      } catch {
        return [];
      }
    });
    expect(hostParents).toContain(mainPid);
    await expect(
      window
        .getByTestId("column-awaiting-cards")
        .getByTestId("group-primary-label")
        .first(),
    ).toContainText("Review");
    // Awaiting cards additionally show how long they've sat in the current
    // awaiting kind (ported from pi-home's awaitingSourceText).
    await expect(
      awaitingCard.getByTestId("card-waiting-duration"),
    ).toContainText("waiting");
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });

  test("the reviewed task's sidebar row shows its repo group, a Review state chip, and a #42 PR chip that routes through the openExternal allowlist", async () => {
    // The rail lists open workspaces only and nothing auto-opens: open the
    // reviewed task from its card first.
    await window
      .getByTestId("column-awaiting-cards")
      .locator('[data-testid^="card-"]')
      .first()
      .click();
    await expect(window.getByTestId("workspace-view")).toBeVisible();

    // The fixture's origin is a local bare repo, so the normalized
    // repository id (and hence the short group name) ends in "bare-origin".
    const group = window.getByTestId("sidebar-group-bare-origin");
    await expect(group).toBeVisible();
    const row = group
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Ship Feature" });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("state-chip")).toHaveText("Review");
    await expect(row.getByTestId("sidebar-row-branch")).not.toBeEmpty();

    const chip = row.getByTestId("pr-chip");
    await expect(chip).toHaveText("#42");
    await expect(chip).toHaveAttribute(
      "data-pr-url",
      "https://example.invalid/fixture/pull/42",
    );

    // The fake gh reports a non-GitHub URL, so main's allowlist (see
    // main/external-url.ts, unit-tested in tests/external-url.test.ts)
    // refuses it: no browser launches and the renderer surfaces a warning.
    const opened = await window.evaluate(() =>
      window.harbormaster.shell.openExternal(
        "https://example.invalid/fixture/pull/42",
      ),
    );
    expect(opened).toBe(false);
    const pressedBefore = await row.getAttribute("aria-pressed");
    await chip.click();
    const warning = window.getByTestId("toast-warning");
    await expect(warning).toContainText("only github.com links");
    // Clicking the chip never doubles as a row click (no focus change).
    await expect(row).toHaveAttribute("aria-pressed", pressedBefore ?? "");
    await warning.getByTestId("toast-dismiss").dispatchEvent("click");
    await expect(window.getByTestId("toast-warning")).toHaveCount(0);

    // Leave the app on the board view, where the next test starts.
    await window.getByTestId("board-button").click();
    await expect(window.getByTestId("board-view")).toBeVisible();
  });

  test("Done on a clean scratch task moves it straight to the Done column with no warning", async () => {
    // The previous test ended on the board view; back to the workspace view
    // for its sidebar "+ New task" button.
    await window.getByTestId("workspace-button").click();
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Quick Scratch Fix");
    await chooseWhere(window, "none");
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

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

    // Done from the board: select the card and press x (cards carry no
    // buttons; `x` runs the same toDone path as the workspace header).
    await selectCard(window, taskId);
    await window.keyboard.press("x");

    const doneCard = window
      .getByTestId("column-done-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(doneCard).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("toast-warning")).toHaveCount(0);
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });

  test("dragging a branch-backed Dev card to Awaiting opens the Await picker; confirming the preselected review kind pushes the branch and the PR badge appears", async () => {
    await window.getByTestId("workspace-button").click();
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Drag Review");
    await chooseWhere(window, { index: 1 });
    await submitAs(window, "park");
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Drag Review");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);
    await window.evaluate(
      (id) => window.harbormaster.core.startTask(id),
      taskId,
    );
    const devCard = window
      .getByTestId("column-dev-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(devCard).toBeVisible();
    const branch = await window.evaluate(
      async (id) => (await window.harbormaster.core.getTask(id))?.branch,
      taskId,
    );

    await dragTo(window, devCard, window.getByTestId("column-awaiting"));
    await expect(window.getByTestId("await-picker")).toBeVisible();
    await expect(window.getByTestId("await-picker-kind-review")).toBeChecked();
    await window.getByTestId("await-picker-confirm").click();

    const awaitingCard = window
      .getByTestId("column-awaiting-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(awaitingCard).toBeVisible({ timeout: 15_000 });
    await expect(awaitingCard.getByTestId("badge-pr")).toContainText("PR #42");
    // The review kind's onEnter pushed the branch (a plain moveTask never would).
    const remoteRefs = execFileSync(
      "git",
      ["ls-remote", "--heads", path.join(root, "bare-origin.git")],
      { encoding: "utf8" },
    );
    expect(remoteRefs).toContain(`refs/heads/${branch}`);
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });

  test("dragging a repo-backed card to Done runs the Done cleanup: its clean worktree is removed and the binding parked", async () => {
    await window.getByTestId("workspace-button").click();
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Drag Done");
    await chooseWhere(window, { index: 1 });
    await submitAs(window, "park");
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Drag Done");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);
    await window.evaluate(
      (id) => window.harbormaster.core.startTask(id),
      taskId,
    );
    const devCard = window
      .getByTestId("column-dev-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(devCard).toBeVisible();
    const worktreePath = await window.evaluate(
      async (id) =>
        (await window.harbormaster.core.getTaskWorkspace(id))?.worktreePath,
      taskId,
    );
    expect(worktreePath && existsSync(worktreePath)).toBe(true);

    await dragTo(window, devCard, window.getByTestId("column-done"));
    // The PR is open, not merged: the same question the Done button asks.
    const confirm = window.getByTestId("confirm-dialog");
    await expect(confirm).toContainText("Delete unmerged task workspace?");
    await window.getByTestId("confirm-dialog-confirm").click();
    await expect(confirm).toHaveCount(0);

    await expect(
      window
        .getByTestId("column-done-cards")
        .locator(`[data-testid="card-${taskId}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => existsSync(worktreePath as string), { timeout: 15_000 })
      .toBe(false);
    const binding = await window.evaluate(
      (id) => window.harbormaster.core.getTaskWorkspace(id),
      taskId,
    );
    expect(binding).toBeDefined();
    expect(binding?.worktreePath).toBeUndefined();
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });

  // Last in this lane on purpose: the fake gh's PR #42 is shared by every
  // task here and stays MERGED once merged.
  test("the Await picker's deploy kind squash-merges the open PR via gh and lands the card in the stage-less Production deploy group", async () => {
    // The board button lives in the workspace sidebar (hidden on the board).
    if (!(await window.getByTestId("board-view").isVisible())) {
      await window.getByTestId("board-button").click();
    }
    await expect(window.getByTestId("board-view")).toBeVisible();
    const card = cardLocator(window, "Ship Feature");
    const taskId = await cardTaskId(card);
    await expect(
      window
        .getByTestId("column-awaiting-cards")
        .locator(`[data-testid="card-${taskId}"]`),
    ).toBeVisible();

    await selectCard(window, taskId);
    await window.keyboard.press("r");
    await expect(window.getByTestId("await-picker")).toBeVisible();
    const deploy = window.getByTestId("await-picker-kind-deploy");
    await expect(deploy).toBeEnabled();
    await deploy.check();
    await expect(window.getByTestId("await-picker-notice")).toContainText(
      "Squash-merges PR #42 and enters the deployment pipeline",
    );
    await window.getByTestId("await-picker-confirm").click();
    await expect(window.getByTestId("await-picker")).toHaveCount(0);

    const deployGroup = window
      .getByTestId("column-awaiting-cards")
      .getByTestId("group-primary-label")
      .filter({ hasText: "Production deploy" });
    await expect(deployGroup).toBeVisible({ timeout: 15_000 });
    await expect(
      window
        .getByTestId("column-awaiting-cards")
        .locator(`[data-testid="card-${taskId}"]`)
        .getByTestId("badge-pr"),
    ).toContainText("merged");
    const mergeLog = readFileSync(path.join(root, "gh-merge.log"), "utf8");
    expect(mergeLog).toMatch(/^pr merge 42 --repo \S+ --squash$/m);
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });
});

test.describe("Done on a dirty worktree asks first (pi-home's completion questions)", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-done-confirm-"));
    const stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepoWithBareRemote(root, codeRoot);
    const fakeGh = writeFakeGhSucceeding(root);
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({ automation: true, codeRoot, branchPrefix: "" }),
    );
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
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

  test("cancel keeps the task and its changes in place; confirming both questions lands it and removes the worktree", async () => {
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Dirty Done");
    await chooseWhere(window, { index: 1 });
    await submitAs(window, "park");
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Dirty Done");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);
    await window.evaluate(
      (id) => window.harbormaster.core.startTask(id),
      taskId,
    );
    const devCard = window
      .getByTestId("column-dev-cards")
      .locator(`[data-testid="card-${taskId}"]`);
    await expect(devCard).toBeVisible();
    const worktreePath = (await window.evaluate(
      async (id) =>
        (
          await window.harbormaster.core.getTaskWorkspace(id)
        )?.worktreePath,
      taskId,
    )) as string;
    const dirtyFile = path.join(worktreePath, "uncommitted.txt");
    writeFileSync(dirtyFile, "work in progress\n");
    // A fresh app auto-opens the new task's workspace; a live pane in the
    // worktree would (correctly) skip the questions and keep it. Close it.
    await window.getByTestId("workspace-button").click();
    const closeButton = window.getByTestId("close-workspace-button");
    if ((await closeButton.count()) > 0) {
      await closeButton.click();
      await expect(window.getByTestId("terminal-panel")).toHaveCount(0);
    }
    await window.getByTestId("board-button").click();

    const confirm = window.getByTestId("confirm-dialog");
    await selectCard(window, taskId);
    await window.keyboard.press("x");
    await expect(confirm).toContainText("Discard uncommitted changes?");
    await expect(window.getByTestId("confirm-dialog-message")).toContainText(
      "uncommitted changes",
    );
    await window.getByTestId("confirm-dialog-cancel").click();
    await expect(confirm).toHaveCount(0);
    // Cancel changed nothing: still in Dev, the change still on disk.
    await expect(devCard).toBeVisible();
    expect(existsSync(dirtyFile)).toBe(true);

    await window.keyboard.press("x");
    await expect(confirm).toContainText("Discard uncommitted changes?");
    await window.getByTestId("confirm-dialog-confirm").click();
    // Next question, same as pi-home: the branch never merged.
    await expect(confirm).toContainText("Delete unmerged task workspace?");
    await window.getByTestId("confirm-dialog-confirm").click();
    await expect(confirm).toHaveCount(0);

    await expect(
      window
        .getByTestId("column-done-cards")
        .locator(`[data-testid="card-${taskId}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => existsSync(worktreePath), { timeout: 15_000 })
      .toBe(false);
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
        codeRoot,
        branchPrefix: "",
      }),
    );

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
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
    await chooseWhere(window, { index: 1 });
    await submitAs(window, "park");
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Flaky Gh Task");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);

    // refresh() only inspects dev/awaiting repo-backed tasks (see
    // CoreManager.refresh): move it out of backlog so the next tick's PR
    // status check actually calls the (failing) fake gh.
    await window.evaluate(
      (id) => window.harbormaster.core.startTask(id),
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
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
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

    // The rail only lists *open* task workspaces (see sidebar-model.ts); this
    // state dir was seeded directly (nothing was ever opened through the
    // UI), so open "Fresh Done Task" explicitly from its card before
    // checking the sidebar. This also proves archived tasks stay out of the
    // sidebar even if somehow opened: the app's launch auto-focus may well
    // have picked "Old Archived Task" first (it sorts ahead in Done), and
    // it must still never render as a row.
    await cardLocator(window, "Fresh Done Task").click();
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
    await expect(
      window
        .getByTestId("sidebar-task-row-visible-done-task-1")
        .getByTestId("state-chip"),
    ).toHaveText("Done");
    await expect(
      window
        .getByTestId("sidebar-group-scratch")
        .getByTestId("sidebar-group-count"),
    ).toHaveText("1");
  });
});
