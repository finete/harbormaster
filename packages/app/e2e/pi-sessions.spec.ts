// Wave 4 e2e lane: Pi panes, presence, and the takeover guard, CI-safe (pi
// itself may not be installed). `HARBORMASTER_PI_COMMAND` (see
// packages/core/src/harness/pi-adapter.ts) overrides the launched command,
// so these tests stand in a tiny fake binary (or a deliberately missing
// one) instead of a real `pi` install.
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
import { SessionPresenceAccess } from "@harbormaster/core";
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

// Same guard as e2e/smoke.spec.ts: a main-process `uncaughtException` is a
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

/** Seeds a tmp codeRoot with one git fixture repo so a task can bind to a real workspace (and thus get a "primary pane runs pi" terminal). */
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

async function createTaskWithRepo(window: Page, title: string): Promise<void> {
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-dialog")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill(title);
  await window
    .getByTestId("new-task-repo-select")
    .selectOption("github.com/test/fixture");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
  await window.getByTestId("board-button").click();
}

test.describe("a bound task's primary pane launches HARBORMASTER_PI_COMMAND with the harness env", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let fakePiPath: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-pi-fake-"));
    const stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepo(codeRoot);
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        movers: [],
        codeRoot,
        branchPrefix: "",
      }),
    );

    // A fake `pi`: dumps just its HARBORMASTER_* env (the full host env is
    // large enough that xterm's screen-reader text mirror can truncate it
    // before these lines, so narrow the dump to what the test actually
    // checks) and then idles instead of exiting, so the pty stays alive
    // long enough for the terminal to render its output.
    fakePiPath = path.join(root, "fake-pi");
    writeFileSync(
      fakePiPath,
      "#!/bin/sh\nenv | grep ^HARBORMASTER\nwhile true; do sleep 3600; done\n",
    );
    chmodSync(fakePiPath, 0o755);

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_PI_COMMAND: fakePiPath,
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

  test("the primary pane's terminal shows HARBORMASTER_TASK_ID from the fake pi's env dump", async () => {
    await createTaskWithRepo(window, "Pi Pane Task");
    const card = cardLocator(window, "Pi Pane Task");
    await expect(card).toBeVisible();
    await card.click();

    const panel = window.getByTestId("terminal-panel").first();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("HARBORMASTER_TASK_ID", {
      timeout: 20_000,
    });
    await expect(panel).toContainText("HARBORMASTER=1");
    await expect(window.getByTestId("pi-fallback-warning")).toHaveCount(0);
  });
});

test.describe("a missing pi binary falls back to a plain shell with a dismissible warning", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-pi-missing-"));
    const stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepo(codeRoot);
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
        HARBORMASTER_PI_COMMAND: path.join(
          root,
          "definitely-not-a-real-binary",
        ),
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

  test("the primary pane falls back to a shell and shows a dismissible warning strip", async () => {
    await createTaskWithRepo(window, "Missing Pi Task");
    const card = cardLocator(window, "Missing Pi Task");
    await expect(card).toBeVisible();
    await card.click();

    const panel = window.getByTestId("terminal-panel").first();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-received-output", "true", {
      timeout: 20_000,
    });

    const warning = window.getByTestId("pi-fallback-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("pi not found");

    await window.getByTestId("pi-fallback-warning-dismiss").click();
    await expect(warning).toHaveCount(0);
  });
});

test.describe("the presence poll surfaces a running badge within one poll interval", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let stateDir: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-presence-"));
    stateDir = path.join(root, "state");
    mkdirSync(stateDir, { recursive: true });

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

  test("a presence record written straight through SessionPresenceAccess shows a spinner on the sidebar row within ~5s", async () => {
    await window.getByTestId("sidebar-new-task-button").click();
    await expect(window.getByTestId("new-task-dialog")).toBeVisible();
    await window.getByTestId("new-task-title-input").fill("Presence Task");
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

    const row = window
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Presence Task" });
    await expect(row).toBeVisible();
    const rowTestId = await row.getAttribute("data-testid");
    if (!rowTestId) throw new Error("sidebar row missing data-testid");
    const taskId = rowTestId.replace("sidebar-task-row-", "");

    // Writes straight into this run's state dir from the test process
    // itself — the same access class the harness adapter reads through in
    // the app's main process (no mock, no IPC bypass: this is exactly the
    // presence-reporting extension's write path).
    const presence = new SessionPresenceAccess(path.join(stateDir, "presence"));
    await presence.register({
      taskId,
      sessionPath: "/tmp/fake-session.jsonl",
      pid: process.pid,
      mode: "interactive",
      at: new Date().toISOString(),
    });
    await presence.setTurnActive(
      taskId,
      process.pid,
      true,
      new Date().toISOString(),
    );

    await expect(row.getByTestId("sidebar-row-spinner")).toBeVisible({
      timeout: 10_000,
    });
    // Live-and-working rows also get the activity line and sort first.
    await expect(row.getByTestId("sidebar-row-activity")).toContainText(
      "working",
    );
    await expect(row.getByTestId("sidebar-row-time")).toHaveText("now");

    await window.getByTestId("board-button").click();
    await expect(
      cardLocator(window, "Presence Task").getByTestId("badge-running"),
    ).toBeVisible({ timeout: 10_000 });
  });
});
