// cmux-parity terminal tab bar: live OSC titles (default -> first title
// event -> every subsequent change), click-empty-tab-strip-space = new
// shell, and per-group split buttons. Uses the same
// HARBORMASTER_PI_COMMAND fake-binary pattern as e2e/pi-sessions.spec.ts so
// this suite is CI-safe without a real `pi` install — the fake pi also
// emits an OSC title escape, like the real pi setting the task title.
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
import { dragTo } from "./board-gestures";

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

function cardLocator(window: Page, title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

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

async function createTaskWithRepo(
  window: Page,
  title: string,
): Promise<string> {
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
  const card = cardLocator(window, title);
  const cardTestId = await card.getAttribute("data-testid");
  if (!cardTestId) throw new Error("card missing data-testid");
  const taskId = cardTestId.replace("card-", "");
  // Start it (a drop on Dev — cards carry no buttons).
  await dragTo(window, card, window.getByTestId("column-dev"));
  await expect(window.getByTestId("column-dev-cards")).toContainText(title);
  // `startTask` moves the card optimistically; the worktree/workspace
  // binding that gives the primary pane its real cwd finishes slightly
  // later. Opening the workspace before that resolves is a real (and
  // already cmux-parity-intentional, see TaskWorkspace.tsx) race: a
  // throwaway plain-shell panel is born with no cwd, then a second, real
  // pi panel replaces it as the active tab once the binding lands. Wait it
  // out here so this suite's single-primary-panel assumptions hold.
  await expect
    .poll(
      async () =>
        (
          await window.evaluate(
            (id) => window.harbormaster.core.getTaskWorkspace(id),
            taskId,
          )
        )?.worktreePath,
      { timeout: 20_000 },
    )
    .toBeTruthy();
  return taskId;
}

test.describe("terminal tab bar: live titles, void-click new shell, split buttons", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let fakePiPath: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-tabs-"));
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

    // Fake pi: sets its own OSC title (as the real pi does, with the task
    // title) and dumps HARBORMASTER_* env so the primary-pane pi-launch
    // assertion from pi-sessions.spec.ts still holds here, then idles
    // instead of exiting so the pty survives the whole suite.
    fakePiPath = path.join(root, "fake-pi");
    writeFileSync(
      fakePiPath,
      [
        "#!/bin/sh",
        "printf '\\033]0;Fake Pi Task\\007'",
        "env | grep ^HARBORMASTER",
        "while true; do sleep 3600; done",
        "",
      ].join("\n"),
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
        // Plain-shell panels spawn `$SHELL` with no args (see
        // ptySessions.ts's `defaultShell()`); on a dev machine whose real
        // interactive shell has its own title-setting integration (p10k,
        // Ghostty/cmux shell integration, etc.) that fires within the first
        // prompt draw, that would race this suite's "shows the cwd
        // basename until the first (test-driven) OSC title" assertion. A
        // bare `/bin/sh` has no such integration, so the default holds
        // until the test's own `printf` — exactly what's under test here.
        SHELL: "/bin/sh",
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

  test("end to end: primary pane gets the π prefix, void-click opens a same-group shell with the cwd basename default, tab clicks don't, titles track OSC changes, and split buttons grow the group count", async () => {
    // App.tsx auto-focuses/opens the first task of a fresh board the
    // instant it loads (see App.tsx's `autoFocusedRef` effect) — if that
    // landed on "Tab Parity Task" while it's still parked (pre-`startTask`,
    // no worktree binding yet), its workspace would mount early with a
    // throwaway plain-shell primary pane, and the *real* pi pane created
    // once bound would become a second, separate tab (both intentional,
    // documented behavior in TaskWorkspace.tsx — not a bug). A disposable
    // first task absorbs that auto-focus so "Tab Parity Task" only ever
    // gets the one, real primary pane this suite's single-tab assumptions
    // need.
    await window.getByTestId("sidebar-new-task-button").click();
    await expect(window.getByTestId("new-task-dialog")).toBeVisible();
    await window.getByTestId("new-task-title-input").fill("Auto-focus Decoy");
    await window.getByTestId("new-task-destination-backlog").click();
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);

    const taskId = await createTaskWithRepo(window, "Tab Parity Task");
    const card = cardLocator(window, "Tab Parity Task");
    await expect(card).toBeVisible();

    await card.click();
    await expect(window.getByTestId("workspace-view")).toBeVisible();

    // Scoped to this task's own workspace: WorkspaceView keeps every opened
    // task's workspace mounted (just `display: none` when unfocused, see
    // WorkspaceView.tsx), so unscoped testid locators would also match the
    // decoy task's panel/tabs.
    const workspace = window.getByTestId(`task-workspace-${taskId}`);
    const dockviewHost = workspace.getByTestId("dockview-host");
    const panels = workspace.getByTestId("terminal-panel");
    const tabs = workspace.getByTestId("terminal-tab");
    const tabTitles = workspace.getByTestId("terminal-tab-title");

    // --- primary (pi) pane: "π" before any title, "π <title>" after ---
    await expect(panels).toHaveCount(1);
    await expect(tabTitles.first()).toHaveText("π Fake Pi Task", {
      timeout: 20_000,
    });
    await expect(tabs.first()).toHaveAttribute("title", "π Fake Pi Task");

    // --- group count starts at one group ---
    await expect(dockviewHost.locator(".groupview")).toHaveCount(1);

    // --- click-empty-tab-strip-space opens a new shell in the SAME group,
    // defaulting to the cwd's basename until its first title event ---
    const binding = await window.evaluate(
      (id) => window.harbormaster.core.getTaskWorkspace(id),
      taskId,
    );
    if (!binding?.worktreePath) {
      throw new Error("expected a worktree binding for a repo-backed task");
    }
    const expectedBasename = binding.worktreePath
      .replace(/\/+$/, "")
      .split("/")
      .pop();

    // dockview's default panel-renderer mode is "onlyWhenVisible" (see
    // dockview-core's DockviewComponent): only the *active* tab's content
    // is actually mounted, so within one group, adding a tab (which
    // activates it by default) swaps which single `terminal-panel` is
    // rendered rather than growing that count "-" the tab *headers*
    // (always rendered) are what prove a new panel exists here.
    await workspace.getByTestId("tab-strip-void").first().click();
    await expect.poll(async () => tabs.count(), { timeout: 10_000 }).toBe(2);
    // Still one group: the void-click added a tab, not a split.
    await expect(dockviewHost.locator(".groupview")).toHaveCount(1);
    await expect(panels).toHaveCount(1);
    await expect(tabTitles.nth(1)).toHaveText(expectedBasename ?? "", {
      timeout: 10_000,
    });

    // --- clicking an existing tab must NOT add a new panel ---
    await tabs.first().click();
    await window.waitForTimeout(300);
    await expect(tabs).toHaveCount(2);
    await expect(panels).toHaveCount(1);

    // --- the new shell's title tracks a live OSC title change (switch
    // back to it first: the previous assertion's tab click activated the
    // primary pane instead) ---
    await tabs.nth(1).click();
    await panels.first().click();
    await window.keyboard.type("printf '\\033]0;MY-TITLE\\007'");
    await window.keyboard.press("Enter");
    await expect(tabTitles.nth(1)).toHaveText("MY-TITLE", { timeout: 10_000 });

    // --- split buttons grow the group count, each in its own direction ---
    // (each split creates a new *group*, which always renders its own
    // active panel in parallel with the others, so `panels` does grow here)
    await workspace.getByTestId("split-right-button").first().click();
    await expect
      .poll(async () => dockviewHost.locator(".groupview").count(), {
        timeout: 10_000,
      })
      .toBe(2);
    await expect.poll(async () => panels.count(), { timeout: 10_000 }).toBe(2);

    await workspace.getByTestId("split-down-button").first().click();
    await expect
      .poll(async () => dockviewHost.locator(".groupview").count(), {
        timeout: 10_000,
      })
      .toBe(3);
    await expect.poll(async () => panels.count(), { timeout: 10_000 }).toBe(3);
  });
});
