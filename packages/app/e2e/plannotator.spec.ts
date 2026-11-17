// Code review via Plannotator (docs/plannotator.md), the one integration
// seam: with the agent idle, the Review button types `/plannotator-review`
// into the task's primary pty (main's pty owner; "Transport"), as the user
// would; the agent (a fake pi reading its terminal, fake-pi.ts
// `writeReviewPi`) runs `plannotator review`; Plannotator runs
// PLANNOTATOR_BROWSER (the app's `harbormaster-open-url` → `harbormaster
// open-url` → core `openTaskUrl` → `task-url-opened`) and the task's review
// tab shows the page in an iframe. Sending the feedback ends the session:
// the tab shows "Review sent" with Review again, which starts a new one.
// The wizard's code review step lists Plannotator as ready for Pi.
// A Claude Code task (fake-claude.ts) covers the other harness's seam: with
// no `/plannotator-review` skill the Review button is disabled; installing
// the skill enables it; removed again before the click (Claude re-reads
// skills live: contract row claude.command.skill-live-remove), the agent
// answers "Unknown command" and the review tab says so instead of spinning.
//
// `plannotator` is a fake on PATH (fake-plannotator.ts) unless
// HARBORMASTER_REAL_PLANNOTATOR=1, which runs the same flow against the
// real binary on PATH (opt-in smoke; the real page has no fake "Send"
// button, so the smoke stops once the page shows in the frame).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  type Page,
  test,
} from "@playwright/test";
import {
  controlFakeClaude,
  waitForFakeClaude,
  writeFakeClaude,
} from "./fake-claude";
import { writeReviewPi } from "./fake-pi";
import { writeFakeOpen, writeFakePlannotator } from "./fake-plannotator";

const REAL = process.env.HARBORMASTER_REAL_PLANNOTATOR === "1";
const REPO_ID = "github.com/test/fixture";
const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
// This checkout's CLI (its `open-url` verb), not whatever a shared
// node_modules/.bin link resolves to.
const cliBin = path.join(
  __dirname,
  "..",
  "..",
  "cli",
  "bin",
  "harbormaster.js",
);

let app: ElectronApplication;
let window: Page;
let root: string;
let taskId: string;
let claudeTaskId: string;
let stateDir: string;
let claudeConfig: string;
let agentLog: string;
let openLog: string;
const mainProcessErrors: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-plannotator-"));
  stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  // Review support probes never read the real ~/.pi or ~/.claude: Pi's
  // extension and Claude's config (skills) live under the test root.
  const piAgentDir = path.join(root, "pi-agent");
  const piExtension = path.join(
    piAgentDir,
    "npm",
    "node_modules",
    "@plannotator",
    "pi-extension",
  );
  mkdirSync(piExtension, { recursive: true });
  writeFileSync(
    path.join(piExtension, "package.json"),
    JSON.stringify({ name: "@plannotator/pi-extension", version: "0.28.66" }),
  );
  claudeConfig = path.join(root, "claude-config");
  mkdirSync(claudeConfig, { recursive: true });
  agentLog = path.join(root, "agent-received.log");
  openLog = path.join(root, "system-open.log");

  // A real repository so the task has a worktree with a change to review.
  const codeRoot = path.join(root, "Code");
  const repo = path.join(codeRoot, "fixture-repo");
  mkdirSync(codeRoot, { recursive: true });
  git(["init", "-q", "-b", "main", repo], root);
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
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
  const seed = createCore({ stateDir });
  const task = await seed.commands.createTask({
    title: "Review me",
    initialPrompt: "",
    repositoryId: REPO_ID,
    start: true,
  });
  taskId = task.id;
  const claudeTask = await seed.commands.createTask({
    title: "Review me with Claude",
    initialPrompt: "",
    repositoryId: REPO_ID,
    harness: "claude-code",
    start: true,
  });
  claudeTaskId = claudeTask.id;
  const binding = await seed.commands.getTaskWorkspace(taskId);
  if (binding?.worktreePath) {
    writeFileSync(
      path.join(binding.worktreePath, "README.md"),
      "hello, review\n",
    );
  }

  // `open` is always a recorder: the script's system-browser fallback must
  // never open a real browser from a test (and must not run at all here).
  const openBin = path.join(root, "open-bin");
  writeFakeOpen(openBin, openLog);
  const fakeBin = path.join(root, "fake-bin");
  if (!REAL) writeFakePlannotator(fakeBin);

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      PATH: [openBin, ...(REAL ? [] : [fakeBin]), process.env.PATH].join(
        path.delimiter,
      ),
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      HARBORMASTER_PI_COMMAND: writeReviewPi(root, agentLog),
      HARBORMASTER_CLAUDE_COMMAND: writeFakeClaude(root),
      PI_CODING_AGENT_DIR: piAgentDir,
      CLAUDE_CONFIG_DIR: claudeConfig,
      HARBORMASTER_CLI_PATH: cliBin,
    },
  });
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (text.includes("[main] uncaughtException")) mainProcessErrors.push(text);
  };
  app.process().stdout?.on("data", onChunk);
  app.process().stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.getByTestId("sidebar").waitFor();
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

function agentReceived(): string {
  return existsSync(agentLog) ? readFileSync(agentLog, "utf8") : "";
}

test("Claude Code: no /plannotator-review skill disables Review; a rejected command shows in the tab", async () => {
  await window.getByTestId("board-button").click();
  await window.getByTestId(`card-${claudeTaskId}`).click();
  await waitForFakeClaude(stateDir, claudeTaskId);
  controlFakeClaude(stateDir, claudeTaskId, "idle");

  // Binary, plugin and Claude Code are current, but the slash command
  // itself (a user skill from Plannotator's install script) is missing.
  const review = window.getByTestId(`review-button-main-${claudeTaskId}`);
  await expect(review).toBeDisabled();

  // Installed: support reads ready (re-probed on window focus).
  const skill = path.join(claudeConfig, "skills", "plannotator-review");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: plannotator-review\n---\n",
  );
  await expect
    .poll(
      async () => {
        await window.evaluate(() => window.dispatchEvent(new Event("focus")));
        return review.isEnabled();
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // Removed again (no focus, so support still reads ready): the running
  // session no longer knows the command.
  rmSync(skill, { recursive: true, force: true });
  await review.click();

  await expect
    .poll(() => waitForFakeClaude(stateDir, claudeTaskId).then((r) => r.typed))
    .toContainEqual(expect.stringMatching(/^\/plannotator-review/));
  const workspace = window.getByTestId(`task-workspace-${claudeTaskId}`);
  await expect(workspace.getByTestId("url-pane-rejected")).toContainText(
    "Claude Code doesn't know /plannotator-review",
  );
});

test("Review runs Plannotator in the task's review tab; sending ends it; Settings shows it ready", async () => {
  await window.getByTestId("board-button").click();
  await window.getByTestId(`card-${taskId}`).click();
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  await expect(workspace.getByTestId("terminal-tab").first()).toBeVisible();
  // The agent is up in its pane (else the click is inbox-delivered).
  await expect(workspace.locator(".xterm-rows")).toContainText(
    "fake review pi ready",
  );

  // Enabled once core reports Plannotator ready for Pi.
  const review = window.getByTestId(`review-button-main-${taskId}`);
  await expect(review).toBeEnabled();
  await expect(review).toHaveAttribute("data-target", "local");
  await review.click();

  // The review tab exists right away, focused, and the harness's command
  // was typed into the agent's terminal (not left in its inbox, which an
  // agent reads as context and never runs as a slash command).
  await expect(workspace.getByTestId("url-tab-title")).toHaveText("Review");
  await expect.poll(agentReceived).toContain('typed "/plannotator-review"');

  // Plannotator ran PLANNOTATOR_BROWSER: the page shows in the tab's frame.
  const frame = workspace.getByTestId("url-pane-frame");
  await expect(frame).toBeVisible({ timeout: 30_000 });
  const firstUrl = await frame.getAttribute("data-url");
  expect(firstUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+/);
  await expect(frame).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups",
  );
  const page = workspace.frameLocator('[data-testid="url-pane-frame"]');
  if (!REAL) {
    await expect(page.getByTestId("fake-plannotator-title")).toHaveText(
      "Fake Plannotator review",
    );
    // Sending the feedback ends the session: the server goes away.
    await page.getByRole("button", { name: "Send feedback" }).click();
    const ended = workspace.getByTestId("url-pane-ended");
    await expect(ended).toContainText(
      "Review sent — the agent is working on it",
    );
    // Review again starts a new session, which navigates the same tab.
    await ended.getByTestId("review-again-button").click();
    await expect(frame).toBeVisible({ timeout: 30_000 });
    await expect(frame).not.toHaveAttribute("data-url", firstUrl ?? "");
    await expect(workspace.getByTestId("url-tab")).toHaveCount(1);
  } else {
    await expect(page.locator("body")).not.toBeEmpty();
  }
  // Everything went through the app: the system browser never ran, and
  // both reviews were typed, none queued as an inbox message.
  expect(existsSync(openLog)).toBe(false);
  expect(agentReceived()).not.toContain("inbox ");

  // Settings → Code review (the same component as the wizard's code review
  // step): Plannotator reads ready for Pi.
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings")?.click();
  });
  await window.getByTestId("settings-nav-code-review").click();
  await expect(window.getByTestId("code-review-row-pi")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(window.getByTestId("code-review-summary")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(
    window.getByTestId("code-review-capture-browser"),
  ).toHaveAttribute("aria-checked", "false");
});
