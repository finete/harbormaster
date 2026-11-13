// Task A: open workspaces + their dockview tab/split layout survive an app
// restart (localStorage under the persisted HARBORMASTER_USER_DATA_DIR
// profile, same relaunch pattern as e2e/board-drag-collapse.spec.ts's
// collapsed-group lane). A fake `pi` (HARBORMASTER_PI_COMMAND) logs its argv
// per launch, same pattern as e2e/session-continuity.spec.ts, so the
// restored primary pane's *resume* (not a fresh `--session-id ... -- prompt`
// launch) is directly assertable.
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
import type { WorkspaceBinding } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
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

function assertNoMainProcessErrors(): void {
  expect(
    mainProcessErrors,
    `main process reported uncaught exception(s):\n${mainProcessErrors.join("\n---\n")}`,
  ).toEqual([]);
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: path.join(root, "fake-pi"),
      HARBORMASTER_GH_COMMAND: path.join(root, "fake-gh"),
    },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
}

async function relaunch(): Promise<void> {
  await app.close();
  assertNoMainProcessErrors();
  await launch();
}

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
  if (!(await window.getByTestId("board-view").isVisible())) {
    await window.getByTestId("board-button").click();
  }
  await cardLocator(title).click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
}

test.beforeAll(async () => {
  root = mkdtempSync(
    path.join(tmpdir(), "harbormaster-e2e-workspace-restore-"),
  );
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

  // Fake pi: same argv-logging shape as session-continuity.spec.ts's.
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
  const fakeGh = path.join(root, "fake-gh");
  writeFileSync(fakeGh, `#!/bin/sh\n${ghGraphqlShimLine(root)}\nprintf '[]'\n`);
  chmodSync(fakeGh, 0o755);

  await launch();
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(root, { recursive: true, force: true });
});

let taskId = "";
let sessionId = "";

test("a task's workspace (primary pi pane + split shell) and the focused rail survive an app restart", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Restore Me");
  await chooseWhere(window, REPO_ID);
  await window.getByTestId("new-task-prompt-input").fill("Kick it off");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  await openTask("Restore Me");
  taskId = await cardTaskId(cardLocator("Restore Me"));
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(1);
  sessionId = bindingFor(taskId)?.sessionId ?? "";
  expect(sessionId).not.toBe("");

  // Add a split shell alongside the primary pi pane.
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  await workspace.getByTestId("split-right-button").first().click();
  await expect(workspace.getByTestId("terminal-panel")).toHaveCount(2);
  await expect(
    workspace.getByTestId("dockview-host").locator(".groupview"),
  ).toHaveCount(2);

  await relaunch();

  // Rail: the task reappears without any card/sidebar click.
  await expect(window.getByTestId(`sidebar-task-row-${taskId}`)).toBeVisible();
  // Focus: its workspace is the one showing, not the empty hint.
  const restoredWorkspace = window.getByTestId(`task-workspace-${taskId}`);
  await expect(restoredWorkspace).toBeVisible();
  await expect(window.getByTestId("workspace-empty-hint")).toHaveCount(0);

  // Both panels came back: the primary pi pane and the split shell.
  await expect(restoredWorkspace.getByTestId("terminal-panel")).toHaveCount(2);
  await expect(
    restoredWorkspace.getByTestId("dockview-host").locator(".groupview"),
  ).toHaveCount(2);

  // The pi pane resumed the existing session (no prompt replay), not a
  // fresh launch.
  await expect.poll(() => launches().length, { timeout: 20_000 }).toBe(2);
  expect(launches()[1]).toEqual(["--session-id", sessionId]);
});

test("closing a workspace, then relaunching, does not restore it", async () => {
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  await workspace.getByTestId("close-workspace-button").click();
  await expect(window.getByTestId("terminal-panel")).toHaveCount(0);
  await expect(window.getByTestId(`sidebar-task-row-${taskId}`)).toHaveCount(0);

  const launchesBeforeRelaunch = launches().length;
  await relaunch();

  await expect(window.getByTestId(`sidebar-task-row-${taskId}`)).toHaveCount(0);
  await expect(window.getByTestId(`task-workspace-${taskId}`)).toHaveCount(0);
  await expect(window.getByTestId("workspace-empty-hint")).toBeVisible();
  // No new pi launch: the closed task's pane never respawned.
  // Intentional fixed wait: proving no new pi launch was spawned within this
  // window. There is no positive observable condition; if a pane were going to
  // respawn it would appear within 500ms.
  await window.waitForTimeout(500);
  expect(launches().length).toBe(launchesBeforeRelaunch);
});
