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
// real): a Pi task, a Claude Code task and a Codex task, each with a dirty
// worktree; their panes start the real agents; the Review button must
// bring up a real Plannotator page in the task's review tab. Claude and
// Codex run the skill through their model (a few tokens). Codex also runs
// the presence scenario (docs/harness-additions.md S4): a turn that leaves
// `sleep 120` running in the background must end at "your move", never
// spinning; its Review then goes through `codex queue` (X5, X9). Then a
// refresh tick through real gh must raise no warning toast, and main must
// log no uncaughtException.
//
// Codex: this machine may have no real `codex` on PATH (only a terminal
// shim), so the Codex cases run only with HARBORMASTER_REAL_SMOKE_CODEX=<path
// to a codex binary> (e.g. the real-CLI tier's pinned install,
// <prefix>/node_modules/.bin/codex); without it they are skipped with that
// message and the marker does not list codex. Codex uses the real
// ~/.codex (its login); trusting the worktree there is Codex's own write.
//
// State, worktrees and the Electron profile live in a temp dir. Agent
// session files land in the real ~/.pi / ~/.claude (the agents need the
// real HOME for auth); the worktree paths name them as smoke runs.
//
// Run: npx electron-vite build && HARBORMASTER_REAL_SMOKE=1 \
//   npx playwright test e2e/real-smoke.spec.ts
//
// Login preflight: before anything launches, every built-in harness must
// be logged in (`claude auth status`, `pi auth check` for Pi's default
// provider); otherwise the run fails with "missing login: …" (release.sh
// stops on that message). A fully passing run writes <repo root>/.real-smoke-ok
// ({ commit, at, harnesses }, gitignored), which `npm run gate:harness`
// checks for freshness (scripts/check-smoke-marker.mjs,
// docs/harness-additions.md P4).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
/** A real Codex binary for the Codex cases (see the header); absent = skipped. */
const CODEX = process.env.HARBORMASTER_REAL_SMOKE_CODEX || undefined;
const CODEX_SKIP =
  "Codex: set HARBORMASTER_REAL_SMOKE_CODEX=<path to a real codex> (e.g. <real-CLI prefix>/node_modules/.bin/codex) to run the Codex cases";
/** Built-in harnesses this smoke covers (recorded in the marker). */
const HARNESSES = CODEX
  ? (["pi", "claude-code", "codex"] as const)
  : (["pi", "claude-code"] as const);
/** Number of `test(...)` cases that run below; the marker needs every one passed. */
const SMOKE_TESTS = CODEX ? 6 : 4;
const MARKER = path.join(repoRoot, ".real-smoke-ok");
/**
 * The PATH a Dock launch would see for agents: a terminal multiplexer's
 * per-session CLI shims (cmux) are not the tools.
 */
const AGENT_PATH = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((entry) => !entry.includes("cmux-cli-shims"))
  .join(path.delimiter);

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.skip(!ENABLED, "HARBORMASTER_REAL_SMOKE=1 runs the real-tool smoke");

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
const tasks: Record<"pi" | "claude" | "codex", string> = {
  pi: "",
  claude: "",
  codex: "",
};
const mainProcessErrors: string[] = [];
const mainLog: string[] = [];
let passedTests = 0;
let failedTests = 0;

/** Runs an agent CLI for its JSON status; stdout even on a non-zero exit. */
function agentJson(command: string, args: string[]): unknown {
  let out = "";
  try {
    out = execFileSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, PATH: AGENT_PATH },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    if (failure.code === "ENOENT") throw new Error(`${command} not on PATH`);
    out = failure.stdout ?? "";
    if (!out.trim()) throw new Error(failure.message.split("\n")[0]);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`unexpected output: ${out.trim().slice(0, 200)}`);
  }
}

/** Harnesses without a usable login, with the reason and the fix. */
function missingLogins(): string[] {
  const missing: string[] = [];
  try {
    const status = agentJson("claude", ["auth", "status"]) as {
      loggedIn?: boolean;
    };
    if (status.loggedIn !== true) throw new Error("not logged in");
  } catch (error) {
    missing.push(
      `claude-code (${(error as Error).message}; run \`claude\` and /login)`,
    );
  }
  try {
    const agentDir =
      process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
    const settingsFile = path.join(agentDir, "settings.json");
    const provider = existsSync(settingsFile)
      ? (
          JSON.parse(readFileSync(settingsFile, "utf8")) as {
            defaultProvider?: string;
          }
        ).defaultProvider
      : undefined;
    if (!provider) throw new Error("no default provider");
    const check = agentJson("pi", [
      "auth",
      "check",
      "--provider",
      provider,
      "--json",
    ]) as { status?: string; reason?: string };
    if (check.status !== "ready") {
      throw new Error(`${provider}: ${check.reason ?? check.status}`);
    }
  } catch (error) {
    missing.push(`pi (${(error as Error).message}; run \`pi\` and /login)`);
  }
  if (CODEX) {
    try {
      execFileSync(CODEX, ["login", "status"], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      missing.push(
        `codex (${(error as Error).message.split("\n")[0]}; run \`codex login\`)`,
      );
    }
  }
  return missing;
}

test.afterEach(() => {
  if (test.info().status === "passed") passedTests += 1;
  else if (test.info().status !== "skipped") failedTests += 1;
});

test.beforeAll(async () => {
  // A new run revokes the last one's verdict until it passes in full.
  rmSync(MARKER, { force: true });
  const missing = missingLogins();
  if (missing.length > 0) {
    throw new Error(`real smoke: missing login: ${missing.join("; ")}`);
  }
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
  for (const harness of HARNESSES) {
    const task = await seed.commands.createTask({
      title: `Real smoke ${harness}`,
      initialPrompt: "",
      repositoryId: REPO_ID,
      harness,
      // Codex: cheap turns (the scenario does not depend on the effort).
      ...(harness === "codex" ? { thinking: "low" as const } : {}),
      start: true,
    });
    tasks[harness === "claude-code" ? "claude" : harness] = task.id;
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
      PATH: AGENT_PATH,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_EXTENSIONS_DIR: path.join(root, "pi-extensions"),
      HARBORMASTER_CLI_PATH: cliBin,
      ...(CODEX ? { HARBORMASTER_CODEX_COMMAND: CODEX } : {}),
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

/** Every process whose cwd is under `dir` (the scenario's `sleep 120`, an agent's leftovers). */
function processesUnder(dir: string): number[] {
  try {
    return execFileSync("lsof", ["-t", "-a", "-d", "cwd", "+D", dir], {
      encoding: "utf8",
    })
      .split("\n")
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return []; // none (lsof exits 1)
  }
}

/** How many `sleep 120` processes run on this machine (the S4 scenario's). */
function sleepsRunning(): number {
  try {
    return execFileSync("pgrep", ["-f", "^sleep 120$"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return 0; // none (pgrep exits 1)
  }
}

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (root) {
    for (const pid of [
      ...plannotatorServersUnder(realpathSync(root)),
      ...processesUnder(realpathSync(root)),
    ]) {
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
  // Only a full, fully passing run vouches for this commit (a --grep
  // subset or any failure leaves no marker).
  if (failedTests === 0 && passedTests === SMOKE_TESTS) {
    const commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      MARKER,
      `${JSON.stringify({ commit, at: new Date().toISOString(), harnesses: HARNESSES }, null, 2)}\n`,
    );
  }
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
        // Codex: "Trust this folder?", option 1 "Trust and continue" selected.
        if (
          /Trust this folder\?/.test(text) &&
          /Trust and continue/.test(text)
        ) {
          trustDialog = true;
          await workspace.locator(".xterm").first().click();
          await window.keyboard.press("Enter");
          return false;
        }
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

test("Setup reads Plannotator ready for Pi, Claude Code (and Codex) on this machine", async () => {
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
  if (CODEX) {
    // Binary + the $plannotator-review skill (codex-skill, X9).
    expect(byHarness.codex?.state, JSON.stringify(byHarness.codex)).toBe(
      "ready",
    );
    expect(byHarness.codex?.pieces.map((piece) => piece.id)).toEqual([
      "binary",
      "codex-skill",
    ]);
  }
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

test("Codex: a turn leaving `sleep 120` in the background ends at your move, never running (S4)", async () => {
  test.skip(!CODEX, CODEX_SKIP);
  const taskId = tasks.codex;
  const core = createCore({ stateDir });
  await window.getByTestId("board-button").click();
  await window.getByTestId(`card-${taskId}`).click();
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  await expect(workspace.getByTestId("terminal-tab").first()).toBeVisible();
  // Ready = Codex's first 7501 idle, which follows the folder-trust answer
  // (the dialog itself reports nothing; its prompt line shows behind it).
  await expect
    .poll(
      async () => {
        const text = await screenText(taskId);
        if (
          /Trust this folder\?/.test(text) &&
          /Trust and continue/.test(text)
        ) {
          await workspace.locator(".xterm").first().click();
          await window.keyboard.press("Enter");
          return "trust";
        }
        return (
          (await core.commands.getPresence(taskId)).record?.status?.state ??
          "none"
        );
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe("idle");
  await workspace.locator(".xterm").first().click();
  await window.keyboard.type(
    "Run `sleep 120` in the background, then reply with exactly the word DONE",
  );
  await window.waitForTimeout(300); // Enter on its own, like a person
  await window.keyboard.press("Enter");
  // The turn runs, then ends: done (OSC 9 carries the reply) while the
  // background sleep keeps running.
  await expect
    .poll(async () => (await core.commands.getPresence(taskId)).runningTurn, {
      timeout: 60_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const presence = await core.commands.getPresence(taskId);
        return presence.runningTurn
          ? "running"
          : (presence.record?.status?.state ?? "none");
      },
      { timeout: 180_000, intervals: [1_000] },
    )
    .toMatch(/^(done|idle)$/);
  // Whether the sleep outlives the turn depends on how the model starts
  // it: kept as a Codex "background terminal" it runs on (the recorded
  // background-work fixture: still `done`), as `sleep 120 &` in a one-shot
  // shell it dies with that shell (seen in the app's pane). Recorded, not
  // asserted; the presence verdict below is the scenario.
  const screen = await screenText(taskId);
  test.info().annotations.push({
    type: "codex-background-work",
    description:
      sleepsRunning() > 0 || /background terminal running/.test(screen)
        ? "still running after the turn"
        : "ended with the turn",
  });
  const row = window.getByTestId(`sidebar-task-row-${taskId}`);
  // The behavior is "it stays at rest while sleep runs": watch a while.
  await window.waitForTimeout(10_000);
  await expect(row.getByTestId("sidebar-row-spinner")).toHaveCount(0);
  expect((await core.commands.getPresence(taskId)).runningTurn).toBe(false);
  // SessionStart bound the task to Codex's own session (X3).
  const binding = await core.commands.getTaskWorkspace(taskId);
  expect(binding?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(binding?.sessionPath).toContain(`-${binding?.sessionId}.jsonl`);
});

test("Codex: Review queues $plannotator-review and opens the real Plannotator page", async () => {
  test.skip(!CODEX, CODEX_SKIP);
  const taskId = tasks.codex;
  await reviewShowsRealPlannotator(taskId);
  // Through `codex queue` (X5), not keystrokes.
  expect(mainLog.join("")).toMatch(
    new RegExp(`\\[delivery\\] queued \\{"taskId":"${taskId}"`),
  );
});

test("a refresh tick through real gh raises no warning toast", async () => {
  const result = await window.evaluate(() =>
    window.harbormaster.core.refresh(),
  );
  expect(result.warnings).toEqual([]);
  await expect(window.getByTestId("connectivity-banner")).toHaveCount(0);
  expect(mainLog.join("")).not.toContain("[refresh] warning:");
});
