// Orca polish e2e lane: pin/unpin, inline rename, right-click context menu
// (copy branch/worktree path, reveal in Finder, allowlist-checked), keyboard
// cycling, and the unread ("finished while you weren't looking") emphasis.
// Same no-mock pattern as the rest of the suite: real @harbormaster/core
// against a scratch state dir, `SessionPresenceAccess` written straight from
// the test process (see e2e/pi-sessions.spec.ts) to drive presence without a
// real pi binary.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { chooseWhere } from "./composer";
import { fakePiPid, writeShellPi } from "./fake-pi";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

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

/**
 * Collects every stdout chunk main prints (see `watchForMainProcessErrors`
 * above for the stderr-focused counterpart). Used to assert the
 * renderer->main `app:notify` IPC fired "- main logs receipt unconditionally
 * (see main/index.ts's `registerAppIpc`), ahead of any flag/support check,
 * specifically so this is observable without asserting real OS notification
 * display (Electron has no notification-inspection API, and CI machines
 * often have no notification center at all).
 */
function collectMainStdout(electronApp: ElectronApplication): string[] {
  const lines: string[] = [];
  electronApp.process().stdout?.on("data", (chunk: Buffer) => {
    lines.push(chunk.toString());
  });
  return lines;
}

function rowLocator(window: Page, title: string): Locator {
  return window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: title });
}

function cardLocator(window: Page, title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

async function createScratchTask(window: Page, title: string): Promise<void> {
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill(title);
  await chooseWhere(window, "none");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
}

async function rowTaskId(row: Locator): Promise<string> {
  const testId = await row.getAttribute("data-testid");
  if (!testId) throw new Error("sidebar row missing data-testid");
  return testId.replace("sidebar-task-row-", "");
}

test.describe("scratch-task sidebar polish (pin, rename, cycling, unread)", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let stateDir: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-orca-"));
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
        HARBORMASTER_PI_COMMAND: writeShellPi(root),
      },
    });
    watchForMainProcessErrors(app, mainProcessErrors);
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await createScratchTask(window, "Orca Alpha");
    await createScratchTask(window, "Orca Beta");
  });

  test.afterAll(async () => {
    await app.close();
    expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("pinning a task via its context menu renders it in the Pinned section", async () => {
    const row = rowLocator(window, "Orca Alpha");
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    const menu = window.getByTestId("sidebar-row-context-menu");
    await expect(menu).toBeVisible();
    // Merged: while the menu is open, confirm scratch tasks have copy-branch disabled.
    const copyBranch = menu.getByTestId(
      "sidebar-row-context-menu-item-copy-branch",
    );
    await expect(copyBranch).toHaveAttribute("aria-disabled", "true");
    await menu.getByTestId("sidebar-row-context-menu-item-pin").click();
    await expect(menu).toHaveCount(0);

    const pinnedSection = window.getByTestId("sidebar-pinned-section");
    await expect(pinnedSection).toBeVisible();
    await expect(
      pinnedSection.locator('[data-testid^="sidebar-task-row-"]'),
    ).toContainText("Orca Alpha");

    // Unpin removes it from the Pinned section again.
    await pinnedSection
      .locator('[data-testid^="sidebar-task-row-"]')
      .click({ button: "right" });
    await expect(menu).toBeVisible();
    await menu.getByTestId("sidebar-row-context-menu-item-unpin").click();
    await expect(window.getByTestId("sidebar-pinned-section")).toHaveCount(0);
  });

  test("double-clicking a row's title renames it; the board card picks up the new title", async () => {
    const row = rowLocator(window, "Orca Beta");
    await expect(row).toBeVisible();
    // Captured before the double-click: once renaming, the title becomes an
    // `<input>` and the row's *text content* (which the "Orca Beta" filter
    // matches against) no longer contains it "-" the locator would stop
    // resolving mid-test otherwise.
    const taskId = await rowTaskId(row);
    await row.getByTestId("sidebar-row-title").dblclick();

    const input = window.getByTestId(`sidebar-row-rename-input-${taskId}`);
    await expect(input).toBeVisible();
    await input.fill("Orca Beta Renamed");
    await input.press("Enter");

    await expect(rowLocator(window, "Orca Beta Renamed")).toBeVisible();

    await window.getByTestId("board-button").click();
    await expect(cardLocator(window, "Orca Beta Renamed")).toBeVisible();
    await window.getByTestId("workspace-button").click();
  });

  test("the main process's app:cycle-task push (Cmd/Ctrl+Shift+Up/Down, intercepted via before-input-event exactly like the existing Cmd+W handler) cycles sidebar focus and opens the next task", async () => {
    // Electron's `before-input-event` requires real OS-level window focus to
    // route synthetic key events, which this sandboxed Playwright/CDP
    // environment does not provide "-" the *same* preexisting gap already
    // affects the Cmd+W close-tab shortcut (zero e2e coverage of the main-
    // process interception itself anywhere in this suite). What's genuinely
    // new and testable here is the renderer's handling of the resulting
    // `app:cycle-task` push (see Sidebar.tsx's `onCycleTask` subscription
    // and lib/sidebar-cycle.ts's wrap-around order) "-" so this drives that
    // push the same way main's handler does, via the real IPC channel.
    await rowLocator(window, "Orca Alpha").click();
    await expect(rowLocator(window, "Orca Alpha")).toHaveAttribute(
      "data-selected",
      "true",
    );

    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("app:cycle-task", "down");
      }
    });

    // Exactly one row should now be selected, and it should not be the one
    // we started on (two tasks are open, so "next" is deterministic).
    await expect(async () => {
      const selected = window.locator(
        '[data-testid^="sidebar-task-row-"][data-selected="true"]',
      );
      await expect(selected).toHaveCount(1);
      const testId = await selected.getAttribute("data-testid");
      expect(testId).not.toBe(
        `sidebar-task-row-${await rowTaskId(rowLocator(window, "Orca Alpha"))}`,
      );
    }).toPass({ timeout: 5_000 });
  });

  test("a finished-while-unfocused transition fires the renderer->main notify IPC", async () => {
    await createScratchTask(window, "Notify Target");
    await createScratchTask(window, "Notify Looker");

    const target = rowLocator(window, "Notify Target");
    const looker = rowLocator(window, "Notify Looker");
    await expect(target).toBeVisible();
    await expect(looker).toBeVisible();
    const targetId = await rowTaskId(target);

    // Focus the *other* task, then blur the window itself too (the test
    // hook: a plain DOM `blur` dispatch, exactly what `useTaskNotifications`
    // / `useUnreadTaskIds` already listen for "- see lib/unread.ts's
    // `windowFocused`) so neither "looking" condition holds.
    await looker.click();
    await expect(looker).toHaveAttribute("data-selected", "true");
    await window.evaluate(() => window.dispatchEvent(new Event("blur")));

    const stdout = collectMainStdout(app);

    const presence = new SessionPresenceAccess(path.join(stateDir, "presence"));
    // The chat's pane runs the fake pi; the record must carry its pid.
    const pid = await fakePiPid(stateDir, targetId);
    await presence.register({
      taskId: targetId,
      sessionPath: "/tmp/fake-session-notify.jsonl",
      pid: pid,
      mode: "interactive",
      at: new Date().toISOString(),
    });
    await presence.setTurnActive(targetId, pid, true, new Date().toISOString());
    await expect(target.getByTestId("sidebar-row-spinner")).toBeVisible({
      timeout: 10_000,
    });

    // Turn ends while unfocused (window blurred, a different task selected):
    // the unread transition should push `app:notify`, which main logs
    // receipt of unconditionally (see main/index.ts's `registerAppIpc`).
    await presence.setTurnActive(
      targetId,
      pid,
      false,
      new Date().toISOString(),
    );
    await expect(target.getByTestId("sidebar-row-unread-dot")).toBeVisible({
      timeout: 10_000,
    });

    await expect(() => {
      expect(
        stdout.some(
          (line) =>
            line.includes("app:notify received") && line.includes(targetId),
        ),
      ).toBe(true);
    }).toPass({ timeout: 10_000 });

    // Restore window focus; then clicking the target task should clear the
    // unread dot (merged from the separate "cleared on focus" test).
    await window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await target.click();
    await expect(target.getByTestId("sidebar-row-unread-dot")).toHaveCount(0);
  });
});

test.describe("repo-backed context menu actions (copy branch/worktree path, reveal in Finder)", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let stateDir: string;
  let codeRoot: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-orca-repo-"));
    stateDir = path.join(root, "state");
    codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });

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
      ["remote", "add", "origin", "https://github.com/test/orca-fixture.git"],
      repoCheckout,
    );

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
        HARBORMASTER_PRESENCE_POLL_MS: "250",
      },
    });
    watchForMainProcessErrors(app, mainProcessErrors);
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Start now + repo selected: branch + worktree are created immediately.
    await window.getByTestId("sidebar-new-task-button").click();
    await expect(window.getByTestId("new-task-composer")).toBeVisible();
    await window.getByTestId("new-task-title-input").fill("Orca Repo Task");
    await chooseWhere(window, "github.com/test/orca-fixture");
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  });

  test.afterAll(async () => {
    await app.close();
    expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("copy branch writes the task's branch to the clipboard", async () => {
    const row = rowLocator(window, "Orca Repo Task");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("sidebar-row-branch")).not.toHaveText("");
    const branch = await row.getByTestId("sidebar-row-branch").innerText();

    await row.click({ button: "right" });
    const menu = window.getByTestId("sidebar-row-context-menu");
    await expect(menu).toBeVisible();
    await menu.getByTestId("sidebar-row-context-menu-item-copy-branch").click();

    const clipboard = await window.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboard).toBe(branch);
  });

  test("copy worktree path writes a path under .harbormaster-worktrees to the clipboard", async () => {
    const row = rowLocator(window, "Orca Repo Task");
    await row.click({ button: "right" });
    const menu = window.getByTestId("sidebar-row-context-menu");
    await expect(menu).toBeVisible();
    // Binding lookup is async (fetched when the menu opens); wait for the
    // item to actually appear before clicking it.
    const copyPath = menu.getByTestId(
      "sidebar-row-context-menu-item-copy-worktree-path",
    );
    await expect(copyPath).toBeVisible({ timeout: 5_000 });
    await copyPath.click();

    const clipboard = await window.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboard).toContain(".harbormaster-worktrees");
  });

  test("reveal in Finder calls the main-process IPC with an allowlisted path, never with an arbitrary one", async () => {
    // Stub `shell.showItemInFolder` in the main process so this never
    // actually shells out to (or depends on) a real file manager — only
    // that main's `shell:revealInFolder` handler was invoked, and with a
    // path inside the allowlisted code root, is asserted.
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { __revealCalls: string[] }).__revealCalls = [];
      shell.showItemInFolder = (itemPath: string) => {
        (
          globalThis as unknown as { __revealCalls: string[] }
        ).__revealCalls.push(itemPath);
      };
    });

    const row = rowLocator(window, "Orca Repo Task");
    await row.click({ button: "right" });
    const menu = window.getByTestId("sidebar-row-context-menu");
    await expect(menu).toBeVisible();
    const reveal = menu.getByTestId(
      "sidebar-row-context-menu-item-reveal-in-finder",
    );
    await expect(reveal).toBeVisible({ timeout: 5_000 });
    await reveal.click();

    await expect(async () => {
      const calls = await app.evaluate(
        () =>
          (globalThis as unknown as { __revealCalls: string[] }).__revealCalls,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(codeRoot);
      expect(calls[0]).toContain(".harbormaster-worktrees");
    }).toPass({ timeout: 5_000 });
  });
});
