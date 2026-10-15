// Wave 3a e2e lane: a real git repository seeded under a tmp codeRoot,
// pointed at via the documented user-editable config.json (the one
// permitted state-dir write — see /AGENTS.md). Proves the repository picker,
// derived-branch card subline, and worktree-scoped pty cwd end-to-end
// against the real @harbormaster/core command API (no mocks).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { dragTo } from "./board-gestures";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
let codeRoot: string;
let repoCheckout: string;

// Same guard as e2e/smoke.spec.ts: a main-process `uncaughtException` is a
// bug (destroyed-window/pty race, thrown IPC handler, ...), not noise.
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

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-git-"));
  stateDir = path.join(root, "state");
  codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });

  repoCheckout = path.join(codeRoot, "fixture-repo");
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
  git(
    ["remote", "add", "origin", "https://github.com/test/fixture.git"],
    repoCheckout,
  );

  // The one permitted state-dir write: the documented user-editable
  // config.json, written before launch so createCore()'s JsonConfigAccess
  // loads this codeRoot instead of its own default on first read.
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
    },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(root, { recursive: true, force: true });
});

test("the fixture repo appears in the New Task dialog's repository picker", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();

  await expect(
    window
      .getByTestId("new-task-repo-select")
      .locator('option[value="github.com/test/fixture"]'),
  ).toHaveCount(1);

  await window.getByTestId("new-task-title-input").fill("Add git workspace");
  await window
    .getByTestId("new-task-repo-select")
    .selectOption("github.com/test/fixture");

  await expect(window.getByTestId("new-task-branch-preview")).toBeVisible();

  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
});

test("creating a task with the repo shows a derived branch subline on its card", async () => {
  await window.getByTestId("board-button").click();
  const card = cardLocator("Add git workspace");
  await expect(card).toBeVisible();
  // Parked in Backlog above: starting it (a drop on Dev — cards carry no
  // buttons) derives the branch + worktree.
  await dragTo(window, card, window.getByTestId("column-dev"));

  // TaskCard renders "<branch> \u2192 <targetBranch>" in a font-mono subline
  // once task.branch is set (see components/TaskCard.tsx).
  await expect(card).toContainText(/add-git-workspace-[a-z0-9]{6}/);
  await expect(card).toContainText("\u2192 main");

  await window.getByTestId("workspace-button").click();
});

test("the task's terminal pty spawns inside its .harbormaster-worktrees checkout", async () => {
  await window.getByTestId("board-button").click();
  const card = cardLocator("Add git workspace");
  await card.click();
  await window.getByTestId("workspace-view").waitFor();

  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });

  await panel.click();
  await window.keyboard.type("pwd\n");

  await expect(panel).toContainText(".harbormaster-worktrees", {
    timeout: 20_000,
  });
});
