// Audit finding #11 e2e coverage: a codeRoot with two clones of the same
// fake remote (mirroring arnac/arnac2/arnac3) must show up as ONE option in
// the New Task repository picker, labeled with its checkout count — not
// once per directory. See packages/core/src/access/git-repository-access.ts
// (grouping) and packages/app/src/renderer/src/lib/repository-label.ts
// (the "— N checkouts" label, ported from pi-home's presentation picker).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const REPO_ID = "github.com/test/multi-checkout";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
let codeRoot: string;

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

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-multi-checkout-"));
  stateDir = path.join(root, "state");
  codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });

  // A bare "remote" plus two checkouts of it under codeRoot, named like
  // pi-home's motivating arnac/arnac2 example: same identity, several
  // directories.
  const bare = path.join(root, "upstream.git");
  git(["init", "-q", "--bare", "-b", "main", bare]);

  const primary = path.join(codeRoot, "multi-checkout");
  git(["clone", "-q", bare, primary]);
  writeFileSync(path.join(primary, "README.md"), "fixture\n");
  git(["add", "."], primary);
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
      "-m",
      "init",
    ],
    primary,
  );
  git(["push", "-q", "origin", "main"], primary);
  git(
    [
      "remote",
      "set-url",
      "origin",
      "https://github.com/test/multi-checkout.git",
    ],
    primary,
  );

  const second = path.join(codeRoot, "multi-checkout2");
  git(["clone", "-q", bare, second]);
  git(
    [
      "remote",
      "set-url",
      "origin",
      "https://github.com/test/multi-checkout.git",
    ],
    second,
  );

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

test("two checkouts of the same remote collapse into one New Task repository option, labeled with its checkout count", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();

  const options = window
    .getByTestId("new-task-repo-select")
    .locator(`option[value="${REPO_ID}"]`);
  await expect(options).toHaveCount(1);
  await expect(options).toHaveText(`${REPO_ID} — 2 checkouts`);

  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-title-input").fill("Multi-checkout task");
  await window.getByTestId("new-task-repo-select").selectOption(REPO_ID);
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
});
