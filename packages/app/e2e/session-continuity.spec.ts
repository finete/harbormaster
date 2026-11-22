// Session continuity + Done-task reopen e2e lane (pi-home parity). A fake
// `pi` (HARBORMASTER_PI_COMMAND) appends its argv to a log file per launch,
// so these tests can assert exactly which conversation each pane opened:
// first launch pre-assigns a session id, reopening the task resumes that
// same id (or the exact session file once the extension recorded it), and
// reopening a Done task restores a workspace directory and forks the
// previous conversation into the new cycle. A Done or archived task's
// workspace runs nothing until resumed (its Resume empty state, Enter), and
// a Done card dropped on Working reopens it the same way. Real git fixture
// repo; the extension's `recordTaskSession` call is made from the test
// process through core's command API (exactly the extension's write path).
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
import { createCore, type WorkspaceBinding } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { dragTo } from "./board-gestures";
import { chooseWhere } from "./composer";
import { ghGraphqlShimLine } from "./fake-gh";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const REPO_ID = "github.com/test/fixture";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd }).toString();
}

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
let argvLog: string;
let pidFile: string;
const mainProcessErrors: string[] = [];

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

async function cardTaskId(card: Locator): Promise<string> {
  const testId = await card.getAttribute("data-testid");
  if (!testId) throw new Error("card missing data-testid");
  return testId.replace("card-", "");
}

/** Every fake-pi launch so far, oldest first, each as its argv array. */
function launches(): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("@@launch\n")
    .filter(Boolean)
    .map((chunk) => chunk.split("\n@@end\n").slice(0, -1));
}

function bindingFor(taskId: string): WorkspaceBinding | undefined {
  const file = path.join(stateDir, "workspace-bindings.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as {
    bindings: WorkspaceBinding[];
  };
  return state.bindings.find((binding) => binding.taskId === taskId);
}

async function openTask(title: string): Promise<void> {
  // The board button lives in the workspace sidebar (hidden on the board).
  if (!(await window.getByTestId("board-view").isVisible())) {
    await window.getByTestId("board-button").click();
  }
  await cardLocator(title).click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
}

async function closeWorkspace(): Promise<void> {
  await window.getByTestId("close-workspace-button").click();
  await expect(window.getByTestId("terminal-panel")).toHaveCount(0);
}

/**
 * End the task's (warm, tab-closed) fake pi, standing in for an evicted or
 * exited session so the next open must cold-start and resume. Kills the
 * pty's whole process group (the shell and its `sleep`), then waits until
 * the process is reaped (gone from the process table).
 */
async function killPi(): Promise<void> {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  process.kill(-pid, "SIGKILL");
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-session-"));
  stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  const repoCheckout = path.join(codeRoot, "fixture-repo");
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
      automation: false,
      codeRoot,
      branchPrefix: "",
    }),
  );

  // Fake pi: appends "@@launch" + each arg followed by an "@@end" line to
  // the argv log (unambiguous even for multiline args), echoes, idles.
  argvLog = path.join(root, "pi-argv.log");
  pidFile = path.join(root, "pi.pid");
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'log="$(dirname "$0")/pi-argv.log"',
      '{ printf "@@launch\\n"; for a in "$@"; do printf "%s\\n@@end\\n" "$a"; done; } >> "$log"',
      'echo $$ > "$(dirname "$0")/pi.pid"',
      'echo "FAKE-PI-UP"',
      "while true; do sleep 3600; done",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);
  // gh: never needed here; an empty PR list keeps any refresh inert.
  const fakeGh = path.join(root, "fake-gh");
  writeFileSync(fakeGh, `#!/bin/sh\n${ghGraphqlShimLine(root)}\nprintf '[]'\n`);
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

test.afterEach(() => {
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
});

test.afterAll(async () => {
  await app.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

let taskId = "";
let sessionId = "";
let sessionFile = "";

test("the first pane pre-assigns a session id; a closed tab re-attaches to the same pi; a cold reopen resumes that session", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Continuity");
  await chooseWhere(window, REPO_ID);
  await window.getByTestId("new-task-prompt-input").fill("Kick it off");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  await openTask("Continuity");
  taskId = await cardTaskId(cardLocator("Continuity"));
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(1);
  const [first] = launches();
  sessionId = bindingFor(taskId)?.sessionId ?? "";
  expect(sessionId).not.toBe("");
  expect(first).toEqual(["--session-id", sessionId, "--", "Kick it off"]);

  await expect(window.getByTestId("terminal-panel")).toContainText(
    "FAKE-PI-UP",
  );

  // Closing the tab keeps pi warm: reopening re-attaches to the SAME
  // process (its earlier output replayed from the snapshot), no relaunch.
  await closeWorkspace();
  await openTask("Continuity");
  await expect(window.getByTestId("terminal-panel")).toContainText(
    "FAKE-PI-UP",
  );
  expect(launches()).toHaveLength(1);

  // Once that pi is gone (evicted/exited), the next open cold-starts and
  // resumes the same conversation; the initial prompt is never replayed.
  await closeWorkspace();
  await killPi();
  await openTask("Continuity");
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(2);
  expect(launches()[1]).toEqual(["--session-id", sessionId]);
});

/** Write a session file for `id` and record it for the task, exactly as the extension does on session start. */
async function recordSession(id: string): Promise<string> {
  const file = path.join(root, "sessions", `s_${id}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`,
  );
  const recorded = await createCore({
    stateDir,
  }).commands.recordTaskSession(taskId, { sessionId: id, sessionPath: file });
  expect(recorded).toBe(true);
  return file;
}

test("once the extension recorded the session file, reopening resumes that exact file", async () => {
  sessionFile = await recordSession(sessionId);

  await closeWorkspace();
  await killPi();
  await openTask("Continuity");
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(3);
  expect(launches()[2]).toEqual(["--session", sessionFile]);
});

test("reopening a Done task restores a workspace directory and forks the previous conversation into it", async () => {
  const oldWorktree = bindingFor(taskId)?.worktreePath ?? "";
  expect(existsSync(oldWorktree)).toBe(true);
  await closeWorkspace();

  await window.getByTestId("board-button").click();
  const card = cardLocator("Continuity");
  // The only card on the board, so it is the keyboard selection: x = Done
  // (cards carry no buttons).
  await expect(card).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("x");
  // The single "Mark done?" question (no PR ever merged: it says so).
  const confirm = window.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Mark done?");
  await expect(confirm).toContainText("is not merged");
  await window.getByTestId("confirm-dialog-confirm").click();
  await expect(confirm).toHaveCount(0);
  await expect(
    window
      .getByTestId("column-done-cards")
      .locator(`[data-testid="card-${taskId}"]`),
  ).toBeVisible();
  await expect.poll(() => existsSync(oldWorktree)).toBe(false);
  expect(bindingFor(taskId)?.sessionPath).toBe(sessionFile);

  // Opening the Done task (no worktree left) runs nothing: no stray plain
  // shell, the Resume empty state instead. The header's Reopen asks for an
  // objective first.
  await openTask("Continuity");
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  const resumeCard = workspace.getByTestId(`resume-task-${taskId}`);
  await expect(resumeCard).toContainText("This task is done");
  await expect(workspace.getByTestId("terminal-panel")).toHaveCount(0);
  await workspace.getByTestId(`reopen-task-button-${taskId}`).click();
  const dialog = window.getByTestId("reopen-task-dialog");
  await expect(dialog).toBeVisible();
  await window
    .getByTestId("reopen-task-objective-input")
    .fill("Now add the tests");
  await window.getByTestId("reopen-task-confirm").click();
  await expect(dialog).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await expect(
    window
      .getByTestId("column-working-cards")
      .locator(`[data-testid="card-${taskId}"]`),
  ).toBeVisible();
  await expect(window.getByTestId("toast-error")).toHaveCount(0);
  await expect(window.getByTestId("toast-warning")).toHaveCount(0);
  const reopened = bindingFor(taskId);
  expect(reopened?.worktreePath).toBeTruthy();
  expect(reopened?.worktreePath).not.toBe(oldWorktree);
  expect(existsSync(reopened?.worktreePath ?? "")).toBe(true);
  expect(reopened?.previousSessionPath).toBe(sessionFile);
  const newSessionId = reopened?.sessionId ?? "";
  expect(newSessionId).not.toBe("");
  expect(newSessionId).not.toBe(sessionId);

  // The still-open workspace picked up the new cycle's worktree and gave
  // it a pi pane (its only one), which forked the previous conversation.
  await expect(resumeCard).toHaveCount(0);
  await expect(workspace.getByTestId("terminal-panel")).toHaveCount(1);
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(4);
  expect(launches()[3]).toEqual([
    "--fork",
    sessionFile,
    "--session-id",
    newSessionId,
    "--",
    "Now add the tests",
  ]);

  // The fork is handed out once: the next open resumes the new session.
  await window.getByTestId("board-button").click();
  await closeWorkspace();
  await killPi();
  await openTask("Continuity");
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(5);
  expect(launches()[4]).toEqual(["--session-id", newSessionId]);
});

test("an archived task resumes from its workspace's Resume button; a Done card dropped on Working resumes too", async () => {
  // Cycle 2's conversation, recorded as the extension would.
  const cycleTwo = bindingFor(taskId);
  const cycleTwoFile = await recordSession(cycleTwo?.sessionId ?? "");

  // Archive it from the board (e): Done and off the board in one step.
  await closeWorkspace();
  await window.getByTestId("board-button").click();
  const card = cardLocator("Continuity");
  await expect(card).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("e");
  await expect(window.getByTestId("confirm-dialog")).toContainText("Archive?");
  await window.getByTestId("confirm-dialog-confirm").click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => existsSync(cycleTwo?.worktreePath ?? "")).toBe(false);

  // Its card (behind "show archived") opens the Resume empty state with
  // Resume focused, and again on coming back to the (still mounted, hidden
  // meanwhile) workspace: Enter resumes it.
  await window
    .getByTestId("column-done")
    .getByTestId("toggle-archived-button")
    .click();
  await openTask("Continuity");
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  const resumeCard = workspace.getByTestId(`resume-task-${taskId}`);
  const resumeButton = workspace.getByTestId(`resume-task-button-${taskId}`);
  await expect(resumeCard).toContainText("This task is archived");
  await expect(workspace.getByTestId("terminal-panel")).toHaveCount(0);
  await expect(resumeButton).toBeFocused();
  await window.getByTestId("board-button").click();
  await expect(resumeButton).not.toBeFocused();
  await openTask("Continuity");
  await expect(resumeButton).toBeFocused();
  await window.keyboard.press("Enter");

  // Back in Working in a fresh worktree; the first pane forks cycle 2's
  // conversation (no new objective).
  await expect(resumeCard).toHaveCount(0);
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(6);
  const cycleThree = bindingFor(taskId);
  expect(existsSync(cycleThree?.worktreePath ?? "")).toBe(true);
  expect(launches()[5]).toEqual([
    "--fork",
    cycleTwoFile,
    "--session-id",
    cycleThree?.sessionId,
  ]);
  const resumed = await window.evaluate(
    (id) => window.harbormaster.core.getTask(id),
    taskId,
  );
  expect(resumed?.state).toBe("working");
  expect(resumed?.archivedAt).toBeUndefined();

  // Done again, then its card dragged back to Working: the same reopen
  // (a bare move would leave it in Working with no worktree).
  const cycleThreeFile = await recordSession(cycleThree?.sessionId ?? "");
  await closeWorkspace();
  await window.getByTestId("board-button").click();
  await expect(card).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("x");
  await window.getByTestId("confirm-dialog-confirm").click();
  await expect(
    window
      .getByTestId("column-done-cards")
      .locator(`[data-testid="card-${taskId}"]`),
  ).toBeVisible();
  await expect
    .poll(() => existsSync(cycleThree?.worktreePath ?? ""))
    .toBe(false);
  await dragTo(window, card, window.getByTestId("column-working"));
  await expect(
    window
      .getByTestId("column-working-cards")
      .locator(`[data-testid="card-${taskId}"]`),
  ).toBeVisible();
  const cycleFour = bindingFor(taskId);
  expect(cycleFour?.worktreePath).not.toBe(cycleThree?.worktreePath);
  expect(existsSync(cycleFour?.worktreePath ?? "")).toBe(true);
  expect(cycleFour?.forkFromSessionPath).toBe(cycleThreeFile);
  await expect(window.getByTestId("toast-error")).toHaveCount(0);
  await expect(window.getByTestId("toast-warning")).toHaveCount(0);
});
