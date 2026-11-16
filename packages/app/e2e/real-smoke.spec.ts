// Full local smoke against the REAL tools on this machine (opt-in:
// HARBORMASTER_REAL_SMOKE=1; never part of the default suite). Everything
// the fakes stand in for elsewhere is real here: logged-in `pi` and
// `claude` (the user's own HOME, so their auth, extensions and skills), the
// real `plannotator` binary / Pi extension / Claude plugin + skills, real
// `gh` against GitHub, and the network. Catches the "works with the fake,
// not with the tool" class (docs/plannotator.md "Review button").
//
// What it drives, offscreen, on a local clone of this repository (origin
// github.com/finete/harbormaster, so the refresh loop's PR lookups are
// real): a Pi task and a Claude Code task, each with a dirty worktree;
// their panes start the real agents; the Review button must bring up a
// real Plannotator page in the task's review tab. Claude runs the skill
// through its model (a few tokens). Then a refresh tick through real gh
// must raise no warning toast, and main must log no uncaughtException.
//
// State, worktrees and the Electron profile live in a temp dir. Agent
// session files land in the real ~/.pi / ~/.claude (the agents need the
// real HOME for auth); the worktree paths name them as smoke runs.
//
// Run: npx electron-vite build && HARBORMASTER_REAL_SMOKE=1 \
//   npx playwright test e2e/real-smoke.spec.ts
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const ENABLED = process.env.HARBORMASTER_REAL_SMOKE === "1";
const REPO_ID = "github.com/finete/harbormaster";
const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const repoRoot = path.join(__dirname, "..", "..", "..");
const cliBin = path.join(repoRoot, "packages", "cli", "bin", "harbormaster.js");

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.skip(!ENABLED, "HARBORMASTER_REAL_SMOKE=1 runs the real-tool smoke");

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
const tasks: Record<"pi" | "claude", string> = { pi: "", claude: "" };
const mainProcessErrors: string[] = [];
const mainLog: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-real-smoke-"));
  stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  const repo = path.join(codeRoot, "harbormaster");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", repoRoot, repo]);
  execFileSync("git", [
    "-C",
    repo,
    "remote",
    "set-url",
    "origin",
    "https://github.com/finete/harbormaster.git",
  ]);
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: false, codeRoot, branchPrefix: "smoke/" }),
  );
  const seed = createCore({ stateDir });
  for (const harness of ["pi", "claude-code"] as const) {
    const task = await seed.commands.createTask({
      title: `Real smoke ${harness}`,
      initialPrompt: "",
      repositoryId: REPO_ID,
      harness,
      start: true,
    });
    tasks[harness === "pi" ? "pi" : "claude"] = task.id;
    const binding = await seed.commands.getTaskWorkspace(task.id);
    if (!binding?.worktreePath) throw new Error(`no worktree for ${harness}`);
    writeFileSync(
      path.join(binding.worktreePath, "SMOKE.md"),
      `real smoke change for ${harness}\n`,
    );
  }

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      // The PATH a Dock launch would see for agents: a terminal
      // multiplexer's per-session CLI shims (cmux) are not the tools.
      PATH: (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => !entry.includes("cmux-cli-shims"))
        .join(path.delimiter),
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_EXTENSIONS_DIR: path.join(root, "pi-extensions"),
      HARBORMASTER_CLI_PATH: cliBin,
    },
  });
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    mainLog.push(text);
    if (text.includes("[main] uncaughtException")) mainProcessErrors.push(text);
  };
  app.process().stdout?.on("data", onChunk);
  app.process().stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.getByTestId("sidebar").waitFor();
});

/**
 * `plannotator review` servers started under `dir`. Plannotator's Claude
 * mod launches them detached (`nohup`), so they outlive the agent and the
 * app; the smoke must stop its own (never anyone else's: matched by cwd).
 */
function plannotatorServersUnder(dir: string): number[] {
  let out = "";
  try {
    out = execFileSync(
      "lsof",
      ["-a", "-c", "plannotator", "-d", "cwd", "-Fpn"],
      {
        encoding: "utf8",
      },
    );
  } catch {
    return []; // none running (lsof exits 1)
  }
  const pids: number[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && line.slice(1).startsWith(dir))
      pids.push(pid);
  }
  return pids;
}

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (root) {
    for (const pid of plannotatorServersUnder(realpathSync(root))) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    // Worktrees are registered in the temp clone only; removing the dir
    // removes them.
    rmSync(root, { recursive: true, force: true });
  }
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
});

function terminal(taskId: string): Locator {
  return window
    .getByTestId(`task-workspace-${taskId}`)
    .locator(".xterm-accessibility-tree")
    .first();
}

/** The task pane's visible text (xterm's accessibility mirror, on in e2e). */
async function screenText(taskId: string): Promise<string> {
  return window
    .getByTestId(`task-workspace-${taskId}`)
    .locator(".xterm-accessibility-tree > div")
    .allTextContents()
    .then((rows) => rows.join("\n"))
    .catch(() => "");
}

/**
 * Opens the task's workspace and waits until its agent has drawn its UI.
 * Claude Code in a never-trusted folder (every fresh worktree outside a
 * trusted parent) first shows its folder-trust dialog; answer it like a
 * user would ("Yes, I trust this folder") before going on.
 */
async function openAndSettle(
  taskId: string,
  ready: RegExp,
): Promise<{ trustDialog: boolean }> {
  await window.getByTestId("board-button").click();
  await window.getByTestId(`card-${taskId}`).click();
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  await expect(workspace.getByTestId("terminal-tab").first()).toBeVisible();
  let trustDialog = false;
  await expect
    .poll(
      async () => {
        const text = await screenText(taskId);
        if (/Yes, I trust this folder/.test(text)) {
          trustDialog = true;
          const selected = text
            .split("\n")
            .find((line) => line.includes("\u276f"));
          await workspace.locator(".xterm").first().click();
          await window.keyboard.press(
            selected?.includes("Yes, I trust") ? "Enter" : "ArrowDown",
          );
          return false;
        }
        return ready.test(text);
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(true);
  await expect(window.getByTestId(`review-button-main-${taskId}`)).toBeEnabled({
    timeout: 30_000,
  });
  return { trustDialog };
}

async function reviewShowsRealPlannotator(taskId: string): Promise<void> {
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  await window.getByTestId(`review-button-main-${taskId}`).click();
  await expect(workspace.getByTestId("url-tab-title")).toHaveText("Review");
  const frame = workspace.getByTestId("url-pane-frame");
  try {
    await expect(frame).toBeVisible({ timeout: 120_000 });
  } catch (error) {
    const states0 = await workspace
      .locator('[data-testid^="url-pane-"]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-testid")));
    await workspace.getByTestId("terminal-tab").first().click();
    await window.waitForTimeout(1_000); // let the pane repaint for the capture
    await window.screenshot({
      path: test.info().outputPath(`terminal-${taskId}.png`),
    });
    const screen = await terminal(taskId)
      .textContent({ timeout: 5_000 })
      .catch(() => null);
    const states = states0;
    const reviewLog = mainLog
      .join("")
      .split("\n")
      .filter((line) => line.includes("[review]") || line.includes(taskId))
      .slice(-20)
      .join("\n");
    throw new Error(
      `no Plannotator page for ${taskId}; review tab states ${JSON.stringify(states)}\n--- main.log ---\n${reviewLog}\n--- terminal ---\n${screen ?? "(none)"}`,
      { cause: error },
    );
  }
  expect(await frame.getAttribute("data-url")).toMatch(
    /^http:\/\/(127\.0\.0\.1|localhost):\d+/,
  );
  const page = workspace.frameLocator('[data-testid="url-pane-frame"]');
  await expect(page.locator("body")).not.toBeEmpty({ timeout: 30_000 });
}

test("Setup reads Plannotator ready for Pi and Claude Code on this machine", async () => {
  const support = await window.evaluate(() =>
    window.harbormaster.core.reviewSupport({ refresh: true }),
  );
  const byHarness = Object.fromEntries(
    support.harnesses.map((entry) => [entry.harness, entry]),
  );
  expect(byHarness.pi?.state, JSON.stringify(byHarness.pi)).toBe("ready");
  expect(
    byHarness["claude-code"]?.state,
    JSON.stringify(byHarness["claude-code"]),
  ).toBe("ready");
});

test("Pi: Review opens the real Plannotator page in the review tab", async () => {
  await openAndSettle(tasks.pi, /claude-|gpt-|gemini|model|\$\d|tokens/i);
  await reviewShowsRealPlannotator(tasks.pi);
});

test("Claude Code: Review opens the real Plannotator page in the review tab", async () => {
  const { trustDialog } = await openAndSettle(
    tasks.claude,
    /\? for shortcuts|bypass permissions|accept edits|auto mode/i,
  );
  // Recorded, not asserted: the Review button is enabled during this
  // dialog (presence reads idle), see the run's notes.
  test.info().annotations.push({
    type: "claude-trust-dialog",
    description: String(trustDialog),
  });
  await reviewShowsRealPlannotator(tasks.claude);
});

test("a refresh tick through real gh raises no warning toast", async () => {
  const result = await window.evaluate(() =>
    window.harbormaster.core.refresh(),
  );
  expect(result.warnings).toEqual([]);
  await expect(window.getByTestId("connectivity-banner")).toHaveCount(0);
  expect(mainLog.join("")).not.toContain("[refresh] warning:");
});
