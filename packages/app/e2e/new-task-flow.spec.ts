// New-task flow e2e lane (pi-home parity): the New Task dialog's
// destination choice ("Start now" vs "Park in Backlog"), worktree timing
// (parked tasks get no branch/worktree until started), starting a parked
// card via its Start button or a Backlog -> Dev drag, the initial prompt
// reaching the first pi pane as its launch argument, and the manual refresh
// buttons. Real @harbormaster/core + a real git fixture repo; `pi` and `gh`
// are tiny fakes (HARBORMASTER_PI_COMMAND / HARBORMASTER_GH_COMMAND), so
// nothing ever touches the network or a real GitHub account.
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
import { selectCard } from "./board-gestures";
import { ghGraphqlShimLine } from "./fake-gh";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const REPO_ID = "github.com/test/fixture";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd }).toString();
}

let app: ElectronApplication;
let window: Page;
let root: string;
let repoCheckout: string;
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

/** Task worktrees registered with the fixture repo (excludes the main checkout). */
function taskWorktrees(): string[] {
  return git(["worktree", "list", "--porcelain"], repoCheckout)
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((dir) => dir.includes(".harbormaster-worktrees"));
}

/** The fake gh answers `pr list` with whatever PR json the test last wrote (none = `[]`). */
function writePr(number: number): void {
  writeFileSync(
    path.join(root, "pr.json"),
    JSON.stringify([
      {
        number,
        url: `https://example.invalid/fixture/pull/${number}`,
        state: "OPEN",
        isDraft: false,
        author: { login: "e2e" },
        reviewRequests: [],
        reviews: [],
        headRefOid: "abc1234",
        mergeCommit: null,
        baseRefName: "main",
      },
    ]),
  );
}

// Same dnd-kit drag simulation as e2e/smoke.spec.ts.
async function dragTo(card: Locator, target: Locator): Promise<void> {
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

async function openNewTaskComposer(): Promise<void> {
  await window.getByTestId("board-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
}

/** Creates through the composer, then returns to the board (creating lands in the workspace view). */
async function submitNewTask(options: {
  title: string;
  destination: "start" | "backlog";
  prompt?: string;
}): Promise<void> {
  await openNewTaskComposer();
  await window.getByTestId("new-task-title-input").fill(options.title);
  await window.getByTestId("new-task-repo-select").selectOption(REPO_ID);
  if (options.prompt !== undefined) {
    await window.getByTestId("new-task-prompt-input").fill(options.prompt);
  }
  await window
    .getByTestId(
      options.destination === "start"
        ? "new-task-submit"
        : "new-task-submit-backlog",
    )
    .click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-new-task-"));
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

  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({
      automation: true,
      codeRoot,
      branchPrefix: "",
    }),
  );

  // Fake pi: prints its argv one arg per line (so the test can see exactly
  // what the launch spec passed), then idles so the pty stays alive.
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'echo "PI-ARGC:$#"',
      'for a in "$@"; do printf "PI-ARG:%s\\n" "$a"; done',
      "while true; do sleep 3600; done",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);

  // Fake gh: `pr list` echoes pr.json when present (see writePr), else [].
  const fakeGh = path.join(root, "fake-gh");
  writeFileSync(
    fakeGh,
    [
      "#!/bin/sh",
      ghGraphqlShimLine(root),
      'pr_file="$(dirname "$0")/pr.json"',
      'if [ "$1 $2" = "pr list" ] && [ -f "$pr_file" ]; then',
      '  cat "$pr_file"',
      "else",
      "  printf '[]'",
      "fi",
      "",
    ].join("\n"),
  );
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

test("the draft composer offers Start (primary) vs Park in backlog, plus a prompt and a Task / Chat toggle; closing a non-empty draft asks to discard", async () => {
  await openNewTaskComposer();
  const start = window.getByTestId("new-task-submit");
  const backlog = window.getByTestId("new-task-submit-backlog");
  const repoSelect = window.getByTestId("new-task-repo-select");
  await expect(start).toContainText("Start");
  await expect(backlog).toBeVisible();
  // Opens in Task mode, which needs a repository.
  await expect(window.getByTestId("new-task-mode-task")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(repoSelect).toBeVisible();
  // Nothing typed yet: neither can submit (title is optional, but one of
  // title/prompt must exist).
  await expect(start).toBeDisabled();
  await expect(backlog).toBeDisabled();

  const prompt = window.getByTestId("new-task-prompt-input");
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveAttribute("placeholder", "What should pi do?");
  await prompt.fill("Throwaway");
  // A prompt alone is not enough for a task: no repository chosen yet.
  await expect(start).toBeDisabled();
  await expect(backlog).toBeDisabled();
  await repoSelect.selectOption(REPO_ID);
  await expect(start).toBeEnabled();
  await expect(backlog).toBeEnabled();

  // Chat: no repository picker, nothing else required.
  await window.getByTestId("new-task-mode-chat").click();
  await expect(repoSelect).toHaveCount(0);
  await expect(prompt).toHaveAttribute("placeholder", "Ask pi anything\u2026");
  await expect(start).toContainText("Start chat");
  await expect(start).toBeEnabled();
  await expect(backlog).toBeEnabled();

  await window.getByTestId("sidebar-draft-close").click();
  await window.getByTestId("confirm-dialog-confirm").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  await expect(window.getByTestId("sidebar-draft-row")).toHaveCount(0);
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
});

test("parking a repo task lands in Backlog and creates no branch or worktree", async () => {
  await submitNewTask({
    title: "Parked Work",
    destination: "backlog",
    prompt: "Look into it later",
  });

  const card = cardLocator("Parked Work");
  await expect(
    window.getByTestId("column-backlog-cards").filter({ has: card }),
  ).toBeVisible();
  // No derived-branch subline (TaskCard renders "<branch> → <target>").
  await expect(card).not.toContainText("parked-work-");
  expect(taskWorktrees()).toEqual([]);
  expect(
    git(["branch", "--format=%(refname:short)"], repoCheckout).trim(),
  ).toBe("main");
});

test("s on a selected parked card (cards carry no buttons) creates its worktree and moves it to Dev", async () => {
  const card = cardLocator("Parked Work");
  const taskId = await cardTaskId(card);
  await expect(card.locator("button")).toHaveCount(0);
  await selectCard(window, taskId);
  await window.keyboard.press("s");

  await expect(
    window
      .getByTestId("column-dev-cards")
      .locator(`[data-testid="card-${taskId}"]`),
  ).toBeVisible();
  await expect(card).toContainText(/parked-work-[a-z0-9]{6}/);
  expect(taskWorktrees()).toHaveLength(1);
  expect(taskWorktrees()[0]).toContain("parked-work-");
});

test("Start now lands in Dev with a worktree, and the prompt reaches the first pi pane as its argument", async () => {
  const prompt = "Fix the 'flaky' test\nthen report $HOME";
  await submitNewTask({ title: "Started Work", destination: "start", prompt });

  const card = cardLocator("Started Work");
  await expect(
    window.getByTestId("column-dev-cards").filter({ has: card }),
  ).toBeVisible();
  await expect(card).toContainText(/started-work-[a-z0-9]{6}/);
  expect(
    taskWorktrees().filter((dir) => dir.includes("started-work-")),
  ).toHaveLength(1);

  const taskId = await cardTaskId(card);
  await card.click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  const panel = window
    .getByTestId(`task-workspace-${taskId}`)
    .getByTestId("terminal-panel")
    .first();
  // argv reached pi verbatim: the task's pre-assigned session id first
  // (`--session-id <id>`), then the `--` guard, multiline intact, nothing
  // shell-expanded ($HOME stays literal).
  await expect(panel).toContainText("PI-ARGC:4", { timeout: 20_000 });
  await expect(panel).toContainText("PI-ARG:--session-id");
  await expect(panel).toContainText("PI-ARG:--");
  await expect(panel).toContainText("PI-ARG:Fix the 'flaky' test");
  await expect(panel).toContainText("then report $HOME");
});

test("the workspace header's refresh icon triggers a refresh that updates the board", async () => {
  // Still focused on "Started Work" from the previous test.
  const card = cardLocator("Started Work");
  const taskId = await cardTaskId(card);
  await expect(card.getByTestId("badge-pr")).toHaveCount(0);

  writePr(42);
  const button = window
    .getByTestId(`task-workspace-${taskId}`)
    .getByTestId("workspace-refresh-button");
  await button.click();

  // The refresh's board-changed push lands while the workspace is showing;
  // the (still-mounted) board reflects it.
  await window.getByTestId("board-button").click();
  await expect(card.getByTestId("badge-pr")).toContainText("PR #42", {
    timeout: 10_000,
  });
});

test("the board header's Refresh button shows a busy state and triggers a board update", async () => {
  const card = cardLocator("Started Work");
  writePr(43);
  const button = window.getByTestId("board-refresh-button");
  await button.click();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(card.getByTestId("badge-pr")).toContainText("PR #43", {
    timeout: 10_000,
  });
  await expect(button).toHaveAttribute("aria-busy", "false");
});

test("Cmd/Ctrl+N from the board opens the draft at the top of the sidebar; a prompt-only Start turns it into the focused task with a derived title", async () => {
  await expect(window.getByTestId("board-view")).toBeVisible();
  await window.keyboard.press("ControlOrMeta+N");

  // Leaves the board for the workspace view: draft row pinned first + composer.
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("board-view")).toBeHidden();
  const draftRow = window.getByTestId("sidebar-draft-row");
  await expect(draftRow).toBeVisible();
  await expect(
    window.getByTestId("sidebar-list").locator("> :first-child"),
  ).toHaveAttribute("data-testid", "sidebar-draft-row");
  await expect(draftRow).toContainText("New task");
  await expect(window.getByTestId("new-task-composer")).toBeVisible();

  // Prompt only, no title: the derived title labels the draft live.
  await window
    .getByTestId("new-task-prompt-input")
    .fill("Derive my title from this line\nand ignore the rest");
  await expect(draftRow).toContainText("Derive my title from this line");
  await window.getByTestId("new-task-mode-chat").click();
  await window.getByTestId("new-task-submit").click();

  // The draft row became the real task, focused, in the workspace.
  await expect(draftRow).toHaveCount(0);
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  const row = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Derive my title from this line" });
  await expect(row).toHaveAttribute("data-selected", "true");
  // Top of its group (where the draft row was).
  expect(await row.evaluate((el) => el.previousElementSibling === null)).toBe(
    true,
  );
  const taskId = (await row.getAttribute("data-task-id")) ?? "";
  await expect(window.getByTestId(`task-workspace-${taskId}`)).toBeVisible();
  // A started chat has a scratch workspace, so its primary pane runs pi
  // with the prompt (not a bare shell in the app's own cwd).
  const panel = window
    .getByTestId(`task-workspace-${taskId}`)
    .getByTestId("terminal-panel")
    .first();
  await expect(panel).toContainText("PI-ARG:Derive my title from this line", {
    timeout: 20_000,
  });
});
