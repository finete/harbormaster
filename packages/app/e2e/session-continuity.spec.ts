// Session continuity + Done-task reopen e2e lane (pi-home parity). A fake
// `pi` (HARBORMASTER_PI_COMMAND) appends its argv to a log file per launch,
// so these tests can assert exactly which conversation each pane opened:
// first launch pre-assigns a session id, reopening the task resumes that
// same id (or the exact session file once the extension recorded it), and
// reopening a Done task restores a workspace directory and forks the
// previous conversation into the new cycle. Real git fixture repo; the
// extension's `recordTaskSession` call is made from the test process
// through core's command API (exactly the extension's write path).
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
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'log="$(dirname "$0")/pi-argv.log"',
      '{ printf "@@launch\\n"; for a in "$@"; do printf "%s\\n@@end\\n" "$a"; done; } >> "$log"',
      'echo "FAKE-PI-UP"',
      "while true; do sleep 3600; done",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);
  // gh: never needed here; an empty PR list keeps any refresh inert.
  const fakeGh = path.join(root, "fake-gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf '[]'\n");
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

test("the first pane pre-assigns a session id; reopening the task resumes that same session", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-destination-start").click();
  await window.getByTestId("new-task-title-input").fill("Continuity");
  await window.getByTestId("new-task-repo-select").selectOption(REPO_ID);
  await window.getByTestId("new-task-prompt-input").fill("Kick it off");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

  await openTask("Continuity");
  taskId = await cardTaskId(cardLocator("Continuity"));
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(1);
  const [first] = launches();
  sessionId = bindingFor(taskId)?.sessionId ?? "";
  expect(sessionId).not.toBe("");
  expect(first).toEqual(["--session-id", sessionId, "--", "Kick it off"]);

  await closeWorkspace();
  await openTask("Continuity");
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(2);
  // Same conversation, and the initial prompt is never replayed.
  expect(launches()[1]).toEqual(["--session-id", sessionId]);
});

test("once the extension recorded the session file, reopening resumes that exact file", async () => {
  sessionFile = path.join(root, "sessions", `s_${sessionId}.jsonl`);
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root })}\n`,
  );
  const recorded = await createCore({
    stateDir,
  }).commands.recordTaskSession(taskId, {
    sessionId,
    sessionPath: sessionFile,
  });
  expect(recorded).toBe(true);

  await closeWorkspace();
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
  // No PR ever merged: pi-home's "Delete unmerged task workspace?" question.
  const confirm = window.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Delete unmerged task workspace?");
  await window.getByTestId("confirm-dialog-confirm").click();
  await expect(confirm).toHaveCount(0);
  await expect(
    window
      .getByTestId("column-done-cards")
      .locator(`[data-testid="card-${taskId}"]`),
  ).toBeVisible();
  await expect.poll(() => existsSync(oldWorktree)).toBe(false);
  expect(bindingFor(taskId)?.sessionPath).toBe(sessionFile);

  // Reopen lives in the workspace header: open the Done task (no worktree,
  // so its pane is a plain shell — no pi launch) and reopen from there.
  await openTask("Continuity");
  await window
    .getByTestId(`task-workspace-${taskId}`)
    .getByTestId(`reopen-task-button-${taskId}`)
    .click();
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
      .getByTestId("column-dev-cards")
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
  // it a pi pane, which forked the previous conversation.
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
  await window.getByTestId("workspace-button").click();
  await closeWorkspace();
  await openTask("Continuity");
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(5);
  expect(launches()[4]).toEqual(["--session-id", newSessionId]);
});
