// Persistent main-log e2e lane (see AGENTS.md task brief "Implement
// persistent logging + richer diagnostics"): proves the one integration
// seam a unit test can't — that launching a real task's background pty
// actually leaves a `[pty] spawn`/`[pty] exit` trail in
// `<userData>/logs/main.log`, with the initial prompt redacted. This is
// the exact bug the feature exists for: a launched child task's pty that
// prints nothing (`[process exited with code 0]`) used to be
// undiagnosable after the fact.
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
import { chooseWhere, submitAs } from "./composer";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

/** Seeds a tmp codeRoot with one git fixture repo so a task can bind to a real workspace. */
function seedFixtureRepo(codeRoot: string): string {
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
  git(
    ["remote", "add", "origin", "https://github.com/test/fixture.git"],
    repoCheckout,
  );
  return repoCheckout;
}

/** A fake `pi` that prints one line (proving it actually ran) then exits 0 right away — the bug's exact shape, minus the silence. */
function writeExitingFakePi(dir: string): string {
  const fakePi = path.join(dir, "fake-pi-exit");
  writeFileSync(
    fakePi,
    ["#!/bin/sh", 'echo "hello from fake pi"', "exit 0", ""].join("\n"),
  );
  chmodSync(fakePi, 0o755);
  return fakePi;
}

function sidebarRowLocator(window: Page, title: string): Locator {
  return window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: title });
}

const PROMPT_TEXT = "do not leak this prompt text into the log";

let app: ElectronApplication;
let window: Page;
let root: string;
let userDataDir: string;
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

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-main-log-"));
  const stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  seedFixtureRepo(codeRoot);
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: true, codeRoot, branchPrefix: "" }),
  );
  userDataDir = path.join(stateDir, "electron-profile");

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: userDataDir,
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: writeExitingFakePi(root),
      HARBORMASTER_PRESENCE_POLL_MS: "250",
    },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

function mainLogText(): string {
  try {
    return readFileSync(path.join(userDataDir, "logs", "main.log"), "utf8");
  } catch {
    return "";
  }
}

test("a launched task's pty leaves a redacted spawn line and an exit line in main.log", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Logged Task");
  await window.getByTestId("new-task-prompt-input").fill(PROMPT_TEXT);
  await chooseWhere(window, "github.com/test/fixture");
  await submitAs(window, "background");
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  // Task creation always lands in that task's workspace view now (see
  // smoke.spec.ts); the sidebar row (unlike the board card) stays visible
  // from any view, so it is what reads the new task's id back.
  const row = sidebarRowLocator(window, "Logged Task");
  await expect(row).toBeVisible();
  const testId = await row.getAttribute("data-testid");
  if (!testId) throw new Error("sidebar row missing data-testid");
  const taskId = testId.replace("sidebar-task-row-", "");

  // The fake pi exits almost immediately: wait for both lines to land
  // (async, batched writes — see app-log.ts) instead of a fixed sleep.
  await expect
    .poll(() => mainLogText(), { timeout: 20_000 })
    .toContain(`"task":"${taskId}"`);

  const log = mainLogText();
  const spawnLine = log
    .split("\n")
    .find(
      (line) => line.includes("[pty] spawn") && line.includes(`"${taskId}"`),
    );
  expect(spawnLine, log).toBeTruthy();
  expect(spawnLine).toContain('"kind":"background"');
  expect(spawnLine).not.toContain(PROMPT_TEXT);
  expect(spawnLine).toMatch(/<prompt \d+ chars>/);

  await expect
    .poll(() => mainLogText(), { timeout: 20_000 })
    .toMatch(new RegExp(`\\[pty\\] exit.*"task":"${taskId}"`));
  const exitLine = log
    .split("\n")
    .find(
      (line) => line.includes("[pty] exit") && line.includes(`"${taskId}"`),
    );
  // The first poll's snapshot may predate the exit line; re-read once more.
  const finalLog = mainLogText();
  const finalExitLine =
    exitLine ??
    finalLog
      .split("\n")
      .find(
        (line) => line.includes("[pty] exit") && line.includes(`"${taskId}"`),
      );
  expect(finalExitLine, finalLog).toBeTruthy();
  expect(finalExitLine).toContain('"exitCode":0');
});
