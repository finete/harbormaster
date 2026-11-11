// A re-attached task pane must never stay blank. Fullscreen pi (pi-tui's
// alt-screen renderer) repaints only rows it thinks changed, and repaints
// everything only when the terminal size changes. So a pane whose screen
// went blank behind pi's back (Cmd+K / context-menu Clear wipes xterm's
// buffer; a window reload starts from an empty mirror) stayed black: the
// tab close handed that blank screen to the warm session's mirror, and the
// reopen re-attached at the same size, so pi never got a SIGWINCH.
// Now an attach always forces a full repaint, and Cmd+K/Clear leave an
// alt screen alone.
//
// The fake pi here mimics exactly that renderer: alt screen, hidden cursor
// parked on an empty last row, and a full redraw only on resize.
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
import { chooseWhere } from "./composer";
import { ghGraphqlShimLine } from "./fake-gh";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const REPO_ID = "github.com/test/fixture";
const TITLE = "Blank pane";

let app: ElectronApplication;
let window: Page;
let root: string;
const mainProcessErrors: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

function card(): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: TITLE });
}

function panel(): Locator {
  return window.getByTestId("terminal-panel");
}

/** What the pane actually paints (not the screen-reader mirror, which lags). */
function screen(): Locator {
  return panel().locator(".xterm-rows");
}

async function openTask(): Promise<void> {
  if (!(await window.getByTestId("board-view").isVisible())) {
    await window.getByTestId("board-button").click();
  }
  await card().click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();
}

/**
 * Wait until pi stopped repainting (an attach's two-step repaint nudge is
 * done) and the pane shows its latest frame.
 */
async function waitForSettledFrame(): Promise<void> {
  const redraws = (): string =>
    readFileSync(path.join(root, "redraws"), "utf8");
  await expect
    .poll(
      async () => {
        const before = redraws();
        // Polling a "nothing changes" state needs a quiet interval.
        await window.waitForTimeout(400);
        return before === redraws() &&
          (await screen().innerText()).includes(`PI-ROW-0 redraw=${before}`)
          ? "settled"
          : "repainting";
      },
      { timeout: 10_000 },
    )
    .toBe("settled");
}

async function closeWorkspace(): Promise<void> {
  await window.getByTestId("close-workspace-button").click();
  await expect(panel()).toHaveCount(0);
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-blank-"));
  const stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  const repo = path.join(codeRoot, "fixture-repo");
  git(["init", "-q", "-b", "main", repo], root);
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
    JSON.stringify({ automation: false, codeRoot, branchPrefix: "" }),
  );

  // pi-tui alt-screen stand-in: draws every row but the last, parks the
  // (hidden) cursor on the empty last row, and repaints only on resize.
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(
    fakePi,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "let redraws = 0;",
      "const draw = () => {",
      "  redraws++;",
      "  const rows = process.stdout.rows || 24;",
      '  let out = "\\x1b[2J";',
      "  for (let i = 0; i < rows - 1; i++) out += `\\x1b[${i + 1};1HPI-ROW-${i} redraw=${redraws}`;",
      "  out += `\\x1b[${rows};1H`;",
      "  process.stdout.write(out);",
      `  fs.writeFileSync(${JSON.stringify(path.join(root, "redraws"))}, String(redraws));`,
      "};",
      'process.stdout.write("\\x1b[?1049h\\x1b[?25l");',
      "draw();",
      'process.stdout.on("resize", draw);',
      "setInterval(() => {}, 1 << 30);",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);
  const fakeGh = path.join(root, "fake-gh");
  writeFileSync(fakeGh, `#!/bin/sh\n${ghGraphqlShimLine(root)}\nprintf '[]'\n`);
  chmodSync(fakeGh, 0o755);

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: fakePi,
      HARBORMASTER_GH_COMMAND: fakeGh,
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) {
      mainProcessErrors.push(text.trim());
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("a re-attached pane repaints even when its screen went blank behind pi's back", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill(TITLE);
  await chooseWhere(window, REPO_ID);
  await window.getByTestId("new-task-prompt-input").fill("go");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  await openTask();
  await expect(screen()).toContainText("PI-ROW-0", { timeout: 20_000 });

  // A window reload re-attaches from a mirror that never saw the screen
  // (the reload path detaches without a snapshot), at the same size: the
  // attach must make pi repaint.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await openTask();
  await expect(screen()).toContainText("PI-ROW-0", { timeout: 5_000 });

  // Cmd+K must not wipe a fullscreen program's alt screen behind its back.
  await waitForSettledFrame();
  await panel().click();
  await window.keyboard.press("Meta+k");
  // Intentional fixed wait: the behavior is "nothing happens"; give a wrong
  // clear one frame to reach the DOM before asserting its absence.
  await window.waitForTimeout(300);
  await expect(screen()).toContainText("PI-ROW-0");

  // Close + reopen re-attaches to the warm pi with its screen intact.
  await closeWorkspace();
  await openTask();
  await expect(screen()).toContainText("PI-ROW-0", { timeout: 5_000 });
});
