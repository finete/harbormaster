/**
 * P0-2 acceptance: no pty resize (SIGWINCH) while a pane is hidden.
 *
 * Before the fix: going task → Board → task produced two spurious WINCs
 * (11×6 when hidden, then back to the real size). Each round-trip caused
 * xterm to reflow 10k scrollback lines (44 ms) and pi to re-lay out its
 * entire transcript (135–189 ms), visibly delaying the first wheel response
 * after returning to a task.
 *
 * This spec promotes the prototype in /tmp/hm-e2e/winch.spec.ts.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { dragTo } from "./board-gestures";
import { chooseWhere, submitAs } from "./composer";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

/**
 * A fake pi that logs its initial size and every SIGWINCH it receives.
 * Format: "start <rows> <cols> <worktree>" and "WINCH <rows> <cols>" (stty
 * size order).
 */
function makeFakePi(log: string): string {
  return `#!/bin/bash
trap 'echo "WINCH $(stty size)" >> "${log}"' WINCH
echo "start $(stty size) $(basename "$PWD")" >> "${log}"
printf 'fake-pi ready\\n'
while true; do sleep 0.05; done
`;
}

test("hiding a workspace produces zero SIGWINCH events; a pane mounted hidden never starts pi at a garbage size", async () => {
  test.setTimeout(90_000);

  const root = mkdtempSync(path.join(tmpdir(), "hm-resize-hidden-"));
  const stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });

  const repo = path.join(codeRoot, "fixture-repo");
  git(["init", "-q", "-b", "main", repo]);
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
    repo,
  );
  git(["remote", "add", "origin", "https://github.com/test/fixture.git"], repo);

  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: true, codeRoot, branchPrefix: "" }),
  );

  const log = path.join(root, "winch.log");
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(fakePi, makeFakePi(log));
  chmodSync(fakePi, 0o755);

  const launch = () =>
    electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
        HARBORMASTER_PI_COMMAND: fakePi,
        // e2e needs the a11y mirror to read terminal text; this is already the
        // default set in playwright.config.ts but explicit here for clarity.
        HARBORMASTER_TERMINAL_A11Y_MIRROR: "1",
      },
    });
  let app = await launch();

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Create a task and move it to dev so it gets a worktree + pi pane.
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Resize Hidden Task");
    await chooseWhere(window, "github.com/test/fixture");
    await submitAs(window, "park");

    // Navigate to board and drag card to dev column.
    await window.getByTestId("board-button").click();
    const card = window
      .locator('[data-testid^="card-"]')
      .filter({ hasText: "Resize Hidden Task" });
    const taskId = (await card.getAttribute("data-testid"))!.replace(
      "card-",
      "",
    );
    await dragTo(window, card, window.getByTestId("column-dev"));

    // Wait for worktree to be created.
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              (id) => window.harbormaster.core.getTaskWorkspace(id),
              taskId,
            )
          )?.worktreePath,
        { timeout: 30_000 },
      )
      .toBeTruthy();

    // Open the task workspace (click card).
    await window
      .locator('[data-testid^="card-"]')
      .filter({ hasText: "Resize Hidden Task" })
      .click();

    // Wait for fake-pi to start and log its initial size.
    await expect(window.getByTestId("terminal-panel").first()).toContainText(
      "fake-pi ready",
      { timeout: 30_000 },
    );

    // Settle — give the ResizeObserver time to fire at least once.
    await window.waitForTimeout(800);

    const before = existsSync(log) ? readFileSync(log, "utf8") : "";
    const startLines = before.split("\n").filter((l) => l.startsWith("start "));
    console.log("[resize-hidden] initial log:", JSON.stringify(before));
    expect(startLines.length, "fake-pi should have logged its start size").toBe(
      1,
    );

    // HIDE: click Board (workspace becomes display:none).
    await window.getByTestId("board-button").click();
    await window.waitForTimeout(800);

    const afterHide = readFileSync(log, "utf8");
    const winchesWhileHidden = afterHide
      .slice(before.length)
      .split("\n")
      .filter((l) => l.startsWith("WINCH "));
    console.log("[resize-hidden] WINCs while hidden:", winchesWhileHidden);

    // SHOW: click the task card again.
    await window
      .locator('[data-testid^="card-"]')
      .filter({ hasText: "Resize Hidden Task" })
      .click();
    await window.waitForTimeout(800);

    const afterShow = readFileSync(log, "utf8");
    const winchesTotal = afterShow
      .slice(before.length)
      .split("\n")
      .filter((l) => l.startsWith("WINCH "));
    console.log("[resize-hidden] WINCs total:", winchesTotal);

    // P0-2 acceptance: hide → show must produce zero SIGWINCH events.
    expect(
      winchesWhileHidden,
      `Expected 0 WINCs while hidden, got: ${JSON.stringify(winchesWhileHidden)}`,
    ).toHaveLength(0);
    expect(
      winchesTotal,
      `Expected 0 WINCs total for hide+show, got: ${JSON.stringify(winchesTotal)}`,
    ).toHaveLength(0);

    // MOUNTED HIDDEN: open a second task, then relaunch on the same state.
    // The second task's workspace is restored visible; the first one's
    // (with a fresh pi) mounts behind it, display:none. An unguarded
    // mount-time fit sized that pane 11x6, so its pi started at 11 columns
    // until the task was opened.
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Other Task");
    await chooseWhere(window, "github.com/test/fixture");
    await submitAs(window, "park");
    await window.getByTestId("board-button").click();
    await dragTo(
      window,
      window
        .locator('[data-testid^="card-"]')
        .filter({ hasText: "Other Task" }),
      window.getByTestId("column-dev"),
    );
    await window
      .locator('[data-testid^="card-"]')
      .filter({ hasText: "Other Task" })
      .click();
    await expect
      .poll(() => readFileSync(log, "utf8").match(/^start /gm)?.length ?? 0, {
        timeout: 30_000,
      })
      .toBe(2);
    const firstWorktree = (
      readFileSync(log, "utf8").match(
        /^start \d+ \d+ (\S+)$/m,
      ) as RegExpMatchArray
    )[1] as string;

    await app.close();
    app = await launch();
    await (await app.firstWindow()).waitForLoadState("domcontentloaded");
    const startsFor = (worktree: string): string[] =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("start ") && l.endsWith(` ${worktree}`));
    await expect
      .poll(() => startsFor(firstWorktree).length, { timeout: 30_000 })
      .toBe(2);
    const hiddenStart = startsFor(firstWorktree)[1] as string;
    console.log("[resize-hidden] hidden-mount start:", hiddenStart);
    const [, rows, cols] = hiddenStart.split(" ").map(Number);
    expect(
      cols,
      `hidden-mounted pane started at ${hiddenStart}`,
    ).toBeGreaterThan(20);
    expect(
      rows,
      `hidden-mounted pane started at ${hiddenStart}`,
    ).toBeGreaterThan(6);
  } finally {
    await app.close();
  }
});
