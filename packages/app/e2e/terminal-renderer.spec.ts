/**
 * P0-3 acceptance: WebGL renderer state and context-loss recovery.
 *
 * In CI / offscreen mode, Chromium may not create a WebGL context (software
 * rasterizer or disabled GPU). The test detects this upfront:
 *
 * - If data-renderer="dom" from the start, we can't drive loss/recovery via
 *   WEBGL_lose_context (the canvas has no context). We still assert that the
 *   pane is readable and that the attribute is present. The 3-loss cap cannot
 *   be tested without WebGL.
 *
 * - If data-renderer="webgl", we run the full lifecycle:
 *   1. Starts WebGL.
 *   2. Force context loss → DOM, text still readable.
 *   3. Hide → show → WebGL re-acquired.
 *   4. 3 losses in 5 min → stays DOM.
 *
 * The checklist notes "WebGL re-acquire if drivable" for the e2e guard.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { dragTo } from "./board-gestures";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

const fakePiScript = `#!/bin/sh
printf 'renderer-test-ready\\n'
while true; do sleep 0.1; done
`;

test.describe("terminal renderer lifecycle (P0-3)", () => {
  test("data-renderer attribute present; WebGL lifecycle when available", async () => {
    test.setTimeout(120_000);

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
    git(
      ["remote", "add", "origin", "https://github.com/test/fixture.git"],
      repo,
    );

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
        HARBORMASTER_TERMINAL_A11Y_MIRROR: "1",
      },
    });

    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");

      // Create task + open.
      await window.getByTestId("sidebar-new-task-button").click();
      await window.getByTestId("new-task-title-input").fill("Renderer Test");
      await window
        .getByTestId("new-task-repo-select")
        .selectOption("github.com/test/fixture");
      await window.getByTestId("new-task-destination-backlog").click();
      await window.getByTestId("new-task-submit").click();

      await window.getByTestId("board-button").click();
      const card = window
        .locator('[data-testid^="card-"]')
        .filter({ hasText: "Renderer Test" });
      const taskId = (await card.getAttribute("data-testid"))!.replace(
        "card-",
        "",
      );
      await dragTo(window, card, window.getByTestId("column-dev"));

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
      await expect(window.getByTestId("terminal-panel").first()).toContainText(
        "renderer-test-ready",
        { timeout: 30_000 },
      );

      const panel = window.getByTestId("terminal-panel").first();

      // ── Baseline: data-renderer attribute is always set ──────────────────
      // It will be "webgl" or "dom" depending on whether the GPU is available.
      await expect(panel).toHaveAttribute("data-renderer", /^(webgl|dom)$/, {
        timeout: 5_000,
      });

      const initialRenderer = await panel.getAttribute("data-renderer");
      console.log(`[renderer] initial data-renderer="${initialRenderer}"`);

      if (initialRenderer !== "webgl") {
        // GPU not available in this environment (offscreen/software rasterizer).
        // We can only verify the attribute is present and the terminal works.
        console.log(
          "[renderer] WebGL not available; skipping loss/recovery assertions (expected in CI/offscreen)",
        );
        await expect(panel).toContainText("renderer-test-ready");
        return; // Skip WebGL lifecycle assertions.
      }

      /** Force a WebGL context loss by finding the WebGL canvas. */
      async function forceContextLoss(): Promise<void> {
        const lost = await window.evaluate((): boolean => {
          // xterm may have multiple canvases (WebGL + cursor layer).
          // Find the one that has a live WebGL context.
          const canvases = Array.from(
            document.querySelectorAll("[data-testid='terminal-panel'] canvas"),
          ) as HTMLCanvasElement[];
          for (const canvas of canvases) {
            const gl =
              canvas.getContext("webgl2") ?? canvas.getContext("webgl");
            if (!gl) continue;
            const ext = gl.getExtension("WEBGL_lose_context");
            if (!ext) continue;
            ext.loseContext();
            return true;
          }
          return false;
        });
        if (!lost) throw new Error("Could not find a WebGL canvas to lose");
      }

      // ── Step 2: force loss → DOM ─────────────────────────────────────────
      await forceContextLoss();
      await expect(panel).toHaveAttribute("data-renderer", "dom", {
        timeout: 10_000,
      });
      await expect(panel).toContainText("renderer-test-ready");

      // ── Step 3: hide → show → WebGL re-acquired ──────────────────────────
      await window.getByTestId("board-button").click();
      await window.waitForTimeout(500);
      await window
        .locator('[data-testid^="card-"]')
        .filter({ hasText: "Renderer Test" })
        .click();
      await window.waitForTimeout(500);
      await expect(panel).toHaveAttribute("data-renderer", "webgl", {
        timeout: 10_000,
      });

      // ── Step 4: 3 losses in rapid succession → stays DOM ─────────────────
      // 2nd loss (1st was above).
      await forceContextLoss();
      await expect(panel).toHaveAttribute("data-renderer", "dom", {
        timeout: 10_000,
      });
      // Re-acquire.
      await window.getByTestId("board-button").click();
      await window.waitForTimeout(500);
      await window
        .locator('[data-testid^="card-"]')
        .filter({ hasText: "Renderer Test" })
        .click();
      await window.waitForTimeout(500);
      await expect(panel).toHaveAttribute("data-renderer", "webgl", {
        timeout: 10_000,
      });

      // 3rd loss.
      await forceContextLoss();
      await expect(panel).toHaveAttribute("data-renderer", "dom", {
        timeout: 10_000,
      });
      // Hide + show: 3 losses → must STAY on dom.
      await window.getByTestId("board-button").click();
      await window.waitForTimeout(500);
      await window
        .locator('[data-testid^="card-"]')
        .filter({ hasText: "Renderer Test" })
        .click();
      await window.waitForTimeout(1000);
      await expect(panel).toHaveAttribute("data-renderer", "dom", {
        timeout: 5_000,
      });
    } finally {
      await app.close();
    }
  });
});
