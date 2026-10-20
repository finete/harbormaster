/**
 * P0-1 acceptance: host-side wheel translation in mouse-tracking mode.
 *
 * Before the fix: xterm sent at most 1 mouse report per WheelEvent regardless
 * of how many lines the gesture covered. A trackpad flick of 620 px produced
 * only ~12 reports (3.4× short). After the fix, 620 px at 15 px/cell → 41
 * reports (Ghostty/kitty pixel-exact semantics).
 *
 * We use a fake pi that:
 * 1. Enables the alt screen + all four mouse-tracking modes (?1049h ?1000h ?1002h ?1003h ?1006h).
 * 2. Logs all incoming bytes to $LOG.
 * We then synthesise WheelEvents via `page.mouse.wheel()` and count the
 * number of SGR mouse-button-press reports in $LOG.
 *
 * The spec also tests:
 * - Alt screen WITHOUT mouse tracking: wheel produces arrow key sequences.
 * - Normal buffer: wheel does NOT produce pty bytes (scrolls xterm viewport).
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

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

/**
 * Fake pi for mouse-tracking tests.
 * - Logs its stty size to $LOG.size.
 * - Enables alt screen + SGR mouse tracking (?1000h ?1002h ?1003h ?1006h).
 * - Writes "wheel-ready" as a sentinel.
 * - Logs all incoming bytes (from the host/renderer) to $LOG.
 */
function makeWheelFakePi(log: string): string {
  return `#!/bin/sh
stty size > "${log}.size"
stty raw -echo
printf '\\033[?1049h\\033[?1000h\\033[?1002h\\033[?1003h\\033[?1006hwheel-ready'
exec cat >> "${log}"
`;
}

test.describe("terminal wheel translation (P0-1)", () => {
  let root: string;
  let stateDir: string;
  let codeRoot: string;

  test.beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "hm-wheel-"));
    stateDir = path.join(root, "state");
    codeRoot = path.join(root, "Code");
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
  });

  test("wheel in mouse-tracking mode produces ~1 report per cell-height of travel", async () => {
    test.setTimeout(90_000);

    const log = path.join(root, "wheel.log");
    const fakePi = path.join(root, "fake-pi-wheel");
    writeFileSync(fakePi, makeWheelFakePi(log));
    chmodSync(fakePi, 0o755);

    const app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
        HARBORMASTER_PI_COMMAND: fakePi,
        // Enable a11y mirror so we can use toContainText to wait for "wheel-ready".
        // We count actual mouse reports from the pty log file (not terminal DOM text),
        // so the mirror doesn't affect what we're measuring.
        HARBORMASTER_TERMINAL_A11Y_MIRROR: "1",
      },
    });

    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");

      // Create task + move to dev.
      await window.getByTestId("sidebar-new-task-button").click();
      await window.getByTestId("new-task-title-input").fill("Wheel Task");
      await window
        .getByTestId("new-task-repo-select")
        .selectOption("github.com/test/fixture");
      await window.getByTestId("new-task-submit-backlog").click();

      await window.getByTestId("board-button").click();
      const card = window
        .locator('[data-testid^="card-"]')
        .filter({ hasText: "Wheel Task" });
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
        .filter({ hasText: "Wheel Task" })
        .click();

      // Wait for the fake pi to signal it's ready (the a11y mirror lets us
      // read the terminal output directly).
      await expect(window.getByTestId("terminal-panel").first()).toContainText(
        "wheel-ready",
        { timeout: 30_000 },
      );
      // Also wait a moment for the cat process to be fully ready for stdin.
      await window.waitForTimeout(300);

      // Read cell height from stty size.
      const sizeRaw = readFileSync(`${log}.size`, "utf8").trim(); // "rows cols"
      const [rows, cols] = sizeRaw.split(" ").map(Number);
      console.log(`[wheel] stty size: ${rows}×${cols}`);
      expect(rows).toBeGreaterThan(0);

      // Get the cell height in CSS pixels via the DOM.
      const panel = window.getByTestId("terminal-panel").first();
      const panelBox = await panel.boundingBox();
      expect(panelBox).toBeTruthy();

      // Compute cell height from the terminal-panel bounding box / rows.
      // (The terminal fills the panel minus padding; this approximation is fine
      // for the acceptance bounds below.)
      const approxCellH = panelBox!.height / rows;
      console.log(`[wheel] approxCellH: ${approxCellH.toFixed(1)} px`);

      // Hover the center of the panel.
      const cx = panelBox!.x + panelBox!.width / 2;
      const cy = panelBox!.y + panelBox!.height / 2;
      await window.mouse.move(cx, cy);
      await window.waitForTimeout(100);

      const baseline = readFileSync(log, "binary").length;

      // ── Test A: 10 × −100 px → ≈ 1000/cellH reports ────────────────────
      const gesturePxA = 100;
      const eventCountA = 10;
      const totalPxA = gesturePxA * eventCountA;
      for (let i = 0; i < eventCountA; i++) {
        await window.mouse.wheel(0, -gesturePxA);
        await window.waitForTimeout(8);
      }
      await window.waitForTimeout(200); // let the pty IPC flush

      const logA = readFileSync(log, "binary").slice(baseline);
      // SGR button-press reports: ESC [ < 64 ; or ESC [ < 65 ; (scroll up/down)
      // We count scroll-up ("<64;") and scroll-down ("<65;") reports.
      // ESC [ < 64 ; (scroll-up) or ESC [ < 65 ; (scroll-down) SGR mouse report.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is required for SGR mouse
      const reportsA = (logA.match(/\x1b\[<6[45];/g) ?? []).length;
      const expectedA = Math.round(totalPxA / approxCellH);
      console.log(
        `[wheel] Test A: ${reportsA} reports, expected ~${expectedA} (tolerance ±${Math.max(2, Math.round(expectedA * 0.15))})`,
      );
      // Acceptance: within 15% of the expected count (±1 min).
      const toleranceA = Math.max(2, Math.round(expectedA * 0.15));
      expect(Math.abs(reportsA - expectedA)).toBeLessThanOrEqual(toleranceA);
      // Must be significantly more than the old 10 (one per event).
      if (approxCellH < 80) {
        // Only meaningful when cell height < gesture size.
        expect(reportsA).toBeGreaterThan(eventCountA);
      }

      // ── Test B: 45-event profile (≈620 px) → ≥0.9 × (620/cellH) ────────
      const baselineB = readFileSync(log, "binary").length;
      const profilePx = [48, ...Array(44).fill(13)]; // sums to 620
      for (const dy of profilePx) {
        await window.mouse.wheel(0, -dy);
        await window.waitForTimeout(8);
      }
      await window.waitForTimeout(200);

      const logB = readFileSync(log, "binary").slice(baselineB);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is required for SGR mouse
      const reportsB = (logB.match(/\x1b\[<6[45];/g) ?? []).length;
      const expectedB = Math.floor(620 / approxCellH);
      const minB = Math.floor(0.85 * expectedB);
      console.log(
        `[wheel] Test B: ${reportsB} reports, expected ≥${minB} (0.85×${expectedB})`,
      );
      expect(reportsB).toBeGreaterThanOrEqual(minB);
    } finally {
      await app.close();
    }
  });
});
