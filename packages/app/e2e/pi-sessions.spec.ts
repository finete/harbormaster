// Wave 4 e2e lane: Pi panes, presence, and the takeover guard, CI-safe (pi
// itself may not be installed). `HARBORMASTER_PI_COMMAND` (see
// packages/core/src/harness/pi-adapter.ts) overrides the launched command,
// so these tests stand in a tiny fake binary (or a deliberately missing
// one) instead of a real `pi` install.
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
import { SessionPresenceAccess } from "@harbormaster/core";
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
  await window.getByTestId("new-task-destination-backlog").click();
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
  await window.getByTestId("board-button").click();
  // Parked in Backlog: Start creates the worktree the pi pane runs in.
  // (a drop on Dev — cards carry no buttons).
  await dragTo(
    window,
    cardLocator(window, title),
    window.getByTestId("column-dev"),
  );
  await expect(window.getByTestId("column-dev-cards")).toContainText(title);
}

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
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
        // Fast presence poll so presence-driven assertions resolve in ms, not seconds.
        HARBORMASTER_PRESENCE_POLL_MS: "250",
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

    // The agent loop ends while the session stays open: pi-home's ● "your
    // move" — attention styling on the card and the sidebar row, not a
    // neutral "attached".
    await presence.setTurnActive(
      taskId,
      process.pid,
      false,
      new Date().toISOString(),
    );
    const attention = cardLocator(window, "Presence Task").getByTestId(
      "badge-attention",
    );
    await expect(attention).toBeVisible({ timeout: 10_000 });
    await expect(attention).toHaveText("your move");
    await window.getByTestId("workspace-button").click();
    await expect(row.getByTestId("sidebar-row-attention-dot")).toBeVisible({
      timeout: 10_000,
    });
    await expect(row.getByTestId("sidebar-row-attention-dot")).toHaveAttribute(
      "data-status",
      "attention",
    );
    await expect(row.getByTestId("sidebar-row-activity")).toContainText(
      "your move",
    );
  });
});

test.describe("outside-observation corroboration: a pane-pid mismatch distrusts a stale record, and killing the real pane flips the row idle instantly", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let stateDir: string;
  let pidFile: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-corroboration-"));
    stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepo(codeRoot);
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        codeRoot,
        branchPrefix: "",
      }),
    );

    // A fake `pi` that writes its own (real) pid to a known file before
    // dumping its env and idling: the test needs the actual OS pid of the
    // pane's child process to exercise a real external kill below, which
    // the harness env dump alone doesn't expose.
    pidFile = path.join(root, "fake-pi.pid");
    const fakePiPath = path.join(root, "fake-pi");
    writeFileSync(
      fakePiPath,
      `#!/bin/sh\necho $$ > "${pidFile}"\nenv | grep ^HARBORMASTER\nwhile true; do sleep 3600; done\n`,
    );
    chmodSync(fakePiPath, 0o755);

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
        HARBORMASTER_PI_COMMAND: fakePiPath,
        // Fast presence poll so corroboration assertions resolve in ms, not seconds.
        HARBORMASTER_PRESENCE_POLL_MS: "250",
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

  test("a bogus-pid record never shows the working spinner while the pane is open, and killing the pane's real process flips the row idle well under the poll interval", async () => {
    // "Start now" (the dialog's default destination) lands the task
    // straight in Dev with its worktree created immediately "- no Backlog
    // detour needed (the sidebar's "Tasks" list only surfaces started
    // tasks, same as `pollPresenceOnce`'s own non-done filter).
    await window.getByTestId("sidebar-new-task-button").click();
    await expect(window.getByTestId("new-task-dialog")).toBeVisible();
    await window.getByTestId("new-task-title-input").fill("Corroboration Task");
    await window
      .getByTestId("new-task-repo-select")
      .selectOption("github.com/test/fixture");
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

    const row = window
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Corroboration Task" });
    await expect(row).toBeVisible();
    const rowTestId = await row.getAttribute("data-testid");
    if (!rowTestId) throw new Error("sidebar row missing data-testid");
    const taskId = rowTestId.replace("sidebar-task-row-", "");

    await row.click();
    const panel = window.getByTestId("terminal-panel").first();
    await expect(panel).toBeVisible();
    // The fake pi's env dump only runs after it has already written its pid
    // file, so this also proves the pid file is ready to read.
    await expect(panel).toContainText("HARBORMASTER_TASK_ID", {
      timeout: 20_000,
    });
    // Merged from the first describe: also confirm HARBORMASTER=1 is set and
    // no pi-fallback-warning strip appears (the binary exists and launched).
    await expect(panel).toContainText("HARBORMASTER=1");
    await expect(window.getByTestId("pi-fallback-warning")).toHaveCount(0);
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    const realPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(realPid) && realPid > 0).toBe(true);

    // Readiness probe: first write a *real* presence record (matching realPid)
    // so the next poll tick shows badge-running. Then overwrite with the bogus
    // record; the following poll must reject it via corroboration and the badge
    // must disappear. This replaces a fixed 6s wait with two observable
    // positive-condition transitions.
    const presence = new SessionPresenceAccess(path.join(stateDir, "presence"));
    await presence.register({
      taskId,
      sessionPath: "/tmp/real-session-corroboration.jsonl",
      pid: realPid,
      mode: "interactive",
      at: new Date().toISOString(),
    });
    await presence.setTurnActive(
      taskId,
      realPid,
      true,
      new Date().toISOString(),
    );

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Corroboration Task");
    // Wait for badge-running to appear: confirms the poll processed the real record.
    await expect(card.getByTestId("badge-running")).toBeVisible({
      timeout: 5_000,
    });

    // Now overwrite with the bogus-pid record.
    const bogusPid = 2_147_483_646; // outside any real pid range on this host
    await presence.register({
      taskId,
      sessionPath: "/tmp/bogus-session.jsonl",
      pid: bogusPid,
      mode: "interactive",
      at: new Date().toISOString(),
    });
    await presence.setTurnActive(
      taskId,
      bogusPid,
      true,
      new Date().toISOString(),
    );

    // Wait for badge-running to disappear: confirms corroboration rejected the
    // bogus pid — a deterministic observable transition instead of a fixed wait.
    await expect(card.getByTestId("badge-running")).toHaveCount(0, {
      timeout: 5_000,
    });

    // Kill the pane's real process out from under the app (a crash, an OOM
    // kill, `kill -9` from outside, ...) "- physical process truth, not
    // anything the extension reports.
    process.kill(realPid, "SIGKILL");

    // The row must flip to idle well under the ~5s poll interval (the
    // instant-death push on the pane's own exit event), not on the next
    // scheduled tick.
    await window.getByTestId("workspace-button").click();
    const row2 = window
      .locator('[data-testid^="sidebar-task-row-"]')
      .filter({ hasText: "Corroboration Task" });
    await expect(row2.getByTestId("sidebar-row-status-dot")).toBeVisible({
      timeout: 2_000,
    });
    await expect(row2.getByTestId("sidebar-row-spinner")).toHaveCount(0);
    await expect(row2.getByTestId("sidebar-row-attention-dot")).toHaveCount(0);
  });
});
