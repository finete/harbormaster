/**
 * Terminal renderer: xterm's DOM renderer only (no WebGL).
 *
 * WebGL went blank for minutes after macOS sleep / lock, even on a fresh
 * context, while the DOM renderer kept painting (docs/design-decisions.md
 * "Terminal renderer: DOM"). This guards that no pane ever holds a canvas /
 * GL context again, that the text is real DOM, and that power events leave
 * breadcrumbs in <userData>/logs/wake.log for the next display incident.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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

const fakePiScript = `#!/bin/sh
printf 'renderer-test-ready\\n'
while true; do sleep 0.1; done
`;

test("terminal panes render with the DOM renderer, keep no screen-reader mirror until Settings turns it on; power events reach wake.log", async () => {
  test.setTimeout(90_000);

  const root = mkdtempSync(path.join(tmpdir(), "hm-renderer-"));
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
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(fakePi, fakePiScript);
  chmodSync(fakePi, 0o755);

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: fakePi,
      // Production config: no forced screen-reader mirror (the suite forces
      // it for text assertions; this spec reads the DOM rows directly).
      HARBORMASTER_TERMINAL_A11Y_MIRROR: "0",
    },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Renderer Test");
    await chooseWhere(window, "github.com/test/fixture");
    await submitAs(window, "park");
    await window.getByTestId("board-button").click();
    const card = window
      .locator('[data-testid^="card-"]')
      .filter({ hasText: "Renderer Test" });
    const taskId = (await card.getAttribute("data-testid"))!.replace(
      "card-",
      "",
    );
    await dragTo(window, card, window.getByTestId("column-working"));
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
    await window
      .locator('[data-testid^="card-"]')
      .filter({ hasText: "Renderer Test" })
      .click();

    const panel = window.getByTestId("terminal-panel").first();
    await expect(panel).toContainText("renderer-test-ready", {
      timeout: 30_000,
    });
    await expect(panel).toHaveAttribute("data-renderer", "dom");
    // The DOM renderer paints real text rows and owns no canvas (WebGL
    // drew into canvases; no canvas means no GL context to lose).
    await expect(panel.locator(".xterm-rows")).toContainText(
      "renderer-test-ready",
    );
    expect(await panel.locator("canvas").count()).toBe(0);

    // Screen-reader support is off by default, whatever the OS reports
    // (xterm's mirror froze busy panes); the Settings switch turns it on
    // live for open panes.
    await expect(panel.locator(".xterm-accessibility")).toHaveCount(0);
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("settings")?.click();
    });
    await expect(window.getByTestId("settings-view")).toBeVisible();
    const screenReader = window.getByTestId(
      "setting-input-terminal.screenReader",
    );
    await expect(screenReader).toHaveAttribute("aria-checked", "false");
    await screenReader.click();
    await expect(screenReader).toHaveAttribute("aria-checked", "true");
    await window.keyboard.press("Escape");
    await expect(panel.locator(".xterm-accessibility")).toHaveCount(1);

    // Power events land in the wake log (main's powerMonitor wiring).
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("unlock-screen");
    });
    const wakeLog = path.join(stateDir, "electron-profile", "logs", "wake.log");
    await expect
      .poll(
        () => {
          try {
            return readFileSync(wakeLog, "utf8");
          } catch {
            return "";
          }
        },
        { timeout: 10_000 },
      )
      .toContain("power: unlock-screen");
  } finally {
    await app.close();
  }
});
