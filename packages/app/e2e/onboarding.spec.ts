// The first-run wizard (docs/release-plan.md "Onboarding (four screens)",
// R14) end to end on a fresh state dir: no config → the wizard shows; a
// root under a fake ~/Documents warns (HOME points at a temp dir); a temp
// code root with two git repositories is scanned and one is picked; the
// default agent is Claude Code (a fake `claude --version`); the code
// review step (its own screen, no longer on the agent step) shows the
// Plannotator settings for the chosen agent; the GitHub screen shows the account from a stubbed `gh auth status` and leaves the
// source on with the default rules written; Start lands in the workspace
// with the New task composer open on the picked repository, and the first
// task is created on Claude Code. Along the way: the primary button sits
// inside the card, Enter in the typed path advances, Esc goes back, the
// stepper checks off done steps, and the agent step offers exactly Pi and
// Claude Code (Pi missing, with its install command). A relaunch goes
// straight to the app; Settings… → "Run setup again" reopens the wizard over
// it, and
// its "Check setup" runs the doctor: a Pi older than its minimum version warns
// while git may not use https there (GIT_ALLOW_PROTOCOL=file), so
// `repos.remote` fails for beta: no task is active, so the doctor probes
// only the most recently updated task's repository (beta) and lists alpha
// as not probed.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore, type Task } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { submitAs } from "./composer";
import { writeFakeClaude } from "./fake-claude";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

let root: string;
let home: string;
let stateDir: string;
let codeRoot: string;
let fakeClaude: string;
let env: Record<string, string>;
const mainProcessErrors: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function seedRepository(name: string): void {
  const dir = path.join(codeRoot, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
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
    dir,
  );
  git(["remote", "add", "origin", `https://github.com/acme/${name}.git`], dir);
}

/** A `gh` that is signed in as `octo-e2e` and knows no pull requests. */
function writeFakeGh(): string {
  const file = path.join(root, "fake-gh");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "auth status" ]; then',
      // Holds the doctor in its running state long enough to observe it.
      '  [ -n "$FAKE_GH_AUTH_DELAY" ] && sleep "$FAKE_GH_AUTH_DELAY"',
      "  echo 'github.com'",
      "  echo '  ✓ Logged in to github.com account octo-e2e (keyring)'",
      "  echo '  - Active account: true'",
      "  exit 0",
      "fi",
      "printf '[]'",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

function readConfig(): Record<string, unknown> & {
  codeRoot?: string;
  launch?: { defaultHarness?: string; bypassPermissions?: boolean };
  sources?: { github?: { enabled?: boolean } };
  onboardingCompletedAt?: string;
} {
  return JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
}

/** A `pi` that only answers `--version` (the relaunch's doctor check). */
function writeVersionPi(): string {
  const file = path.join(root, "fake-pi-version");
  writeFileSync(file, ["#!/bin/sh", "echo 'pi 0.0.9-e2e'", ""].join("\n"));
  chmodSync(file, 0o755);
  return file;
}

async function launch(
  overrides: Record<string, string> = {},
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [mainEntry],
    env: { ...env, ...overrides },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) mainProcessErrors.push(text);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return { app, window };
}

test.beforeAll(() => {
  root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-onboarding-")),
  );
  home = path.join(root, "home");
  stateDir = path.join(root, "state");
  codeRoot = path.join(root, "code");
  mkdirSync(path.join(home, "Documents", "projects"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  seedRepository("alpha");
  seedRepository("beta");
  fakeClaude = writeFakeClaude(root);
  env = {
    ...(process.env as Record<string, string>),
    HOME: home,
    HARBORMASTER_SKIP_ONBOARDING: "0",
    HARBORMASTER_STATE_DIR: stateDir,
    HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
    HARBORMASTER_WINDOW_OFFSCREEN: "1",
    HARBORMASTER_CLAUDE_COMMAND: fakeClaude,
    // Pi is "not installed" here: detection must say so, not hang.
    HARBORMASTER_PI_COMMAND: path.join(root, "no-such-pi"),
    HARBORMASTER_GH_COMMAND: writeFakeGh(),
    HARBORMASTER_UPDATE_CHECK: "off",
  };
});

test.afterAll(() => {
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("fresh state dir: the five-screen wizard sets everything up, Start opens the composer, and a relaunch skips it", async () => {
  const first = await launch();
  const { window } = first;
  try {
    const wizard = window.getByTestId("onboarding");
    await expect(wizard).toBeVisible();
    await expect(wizard).toHaveAttribute("data-step", "code");
    await expect(window.getByTestId("workspace-view")).toHaveCount(0);

    // Screen 1: no usual code folder in this home, so ~/harbormaster is
    // suggested; a root under ~/Documents warns; "Use ~/harbormaster
    // instead" fixes it (and creates it).
    const rootInput = window.getByTestId("onboarding-code-root");
    await expect(rootInput).toHaveValue(path.join(home, "harbormaster"));
    await rootInput.fill(path.join(home, "Documents", "projects"));
    await expect(
      window.getByTestId("onboarding-protected-warning"),
    ).toContainText("macOS ties folder permissions to this unsigned build");
    await window.getByTestId("onboarding-use-code").click();
    await expect(rootInput).toHaveValue(path.join(home, "harbormaster"));
    await expect(
      window.getByTestId("onboarding-protected-warning"),
    ).toHaveCount(0);
    expect(existsSync(path.join(home, "harbormaster"))).toBe(true);

    // The primary button sits in the card's own footer, not at the
    // window's edge.
    const card = window.getByTestId("onboarding-card");
    const cardBox = await card.boundingBox();
    const nextBox = await window.getByTestId("onboarding-next").boundingBox();
    expect(cardBox && nextBox).toBeTruthy();
    if (cardBox && nextBox) {
      expect(nextBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(nextBox.y).toBeGreaterThanOrEqual(cardBox.y);
      expect(nextBox.x + nextBox.width).toBeLessThanOrEqual(
        cardBox.x + cardBox.width,
      );
      expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(
        cardBox.y + cardBox.height,
      );
    }
    const stepper = window.getByTestId("onboarding-stepper-step");
    await expect(stepper.nth(0)).toHaveAttribute("data-state", "current");

    // The real code root: both repositories are found; pick beta, then
    // Enter in the typed path advances (keyboard path, no click on Next).
    await rootInput.fill(codeRoot);
    const repos = window.getByTestId("onboarding-repo");
    await expect(repos).toHaveCount(2);
    await expect(repos.nth(0)).toContainText("alpha");
    await expect(repos.nth(1)).toContainText("beta");
    await repos.nth(1).click();
    await expect(repos.nth(1)).toHaveAttribute("data-checked", "true");
    await rootInput.press("Enter");
    await expect(wizard).toHaveAttribute("data-step", "agent");
    expect(readConfig().codeRoot).toBe(codeRoot);
    // The stepper marks the first step done (with a check) and moves on.
    await expect(stepper.nth(0)).toHaveAttribute("data-state", "done");
    await expect(
      stepper.nth(0).getByTestId("onboarding-step-check"),
    ).toBeVisible();
    await expect(stepper.nth(1)).toHaveAttribute("data-state", "current");

    // Screen 2: exactly Pi and Claude Code (no "Other CLI"); Pi is
    // missing and shows its install command, Claude Code is found with
    // where and which version.
    await expect(
      window.getByTestId("onboarding-agent-options").getByRole("radio"),
    ).toHaveCount(2);
    await expect(window.getByText("Other CLI")).toHaveCount(0);
    await expect(
      window.getByTestId("onboarding-agent-claude-code-status"),
    ).toContainText(`found at ${fakeClaude} · v2.1.322`);
    await expect(
      window.getByTestId("onboarding-agent-pi-status"),
    ).toContainText("not found");
    await expect(
      window.getByTestId("onboarding-agent-pi-install"),
    ).toContainText("npm install -g @earendil-works/pi-coding-agent");
    // Esc goes back a step; Enter (focus lands on the path input) comes back.
    await window.keyboard.press("Escape");
    await expect(wizard).toHaveAttribute("data-step", "code");
    await expect(rootInput).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(wizard).toHaveAttribute("data-step", "agent");
    await window.getByTestId("onboarding-agent-claude-code").click();
    await expect(window.getByTestId("onboarding-bypass")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Code review is its own step now, not at the bottom of the agent step.
    await expect(window.getByTestId("code-review-settings")).toHaveCount(0);
    await window.getByTestId("onboarding-next").click();
    await expect(wizard).toHaveAttribute("data-step", "review");
    expect(readConfig().launch).toMatchObject({
      defaultHarness: "claude-code",
      bypassPermissions: true,
    });
    await expect(stepper).toHaveCount(5);
    await expect(stepper.nth(2)).toHaveAttribute("data-state", "current");

    // Screen 3: code review, for the agent just chosen (Claude Code).
    await expect(window.getByTestId("code-review-settings")).toBeVisible();
    await expect(window.getByTestId("code-review-summary")).toContainText(
      "Claude Code",
    );
    await window.getByTestId("onboarding-next").click();
    await expect(wizard).toHaveAttribute("data-step", "github");

    // Screen 4: the gh account; GitHub stays on and the default rules exist.
    await expect(window.getByTestId("onboarding-gh-account")).toContainText(
      "octo-e2e",
    );
    await expect(
      window.getByTestId("onboarding-github-enabled"),
    ).toHaveAttribute("aria-checked", "true");
    await window.getByTestId("onboarding-next").click();
    await expect(wizard).toHaveAttribute("data-step", "concepts");
    expect(readConfig().sources?.github?.enabled).toBe(true);
    expect(existsSync(path.join(stateDir, "rules", "rules.yaml"))).toBe(true);

    // Screen 5 → Start: the workspace with the composer open on beta.
    await expect(window.getByTestId("onboarding-concepts")).toContainText(
      "rules.yaml",
    );
    await expect(window.getByTestId("onboarding-write-rule")).toHaveText(
      "Write your first rule with your agent",
    );
    await expect(window.getByTestId("onboarding-start")).toContainText(
      "Start Harbormaster",
    );
    await expect(window.getByTestId("onboarding-reopen-hint")).toContainText(
      "run this setup again",
    );
    await window.getByTestId("onboarding-start").click();
    await expect(wizard).toHaveCount(0);
    await expect(window.getByTestId("workspace-view")).toBeVisible();
    await expect(window.getByTestId("new-task-composer")).toBeVisible();
    await expect(window.getByTestId("new-task-where")).toHaveAttribute(
      "data-where",
      "repo:github.com/acme/beta",
    );
    expect(readConfig().onboardingCompletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The first task: on beta, on the default agent (Claude Code).
    await window.getByTestId("new-task-title-input").fill("First task");
    await window.getByTestId("new-task-prompt-input").fill("Say hello");
    await submitAs(window, "park");
    const core = createCore({ stateDir });
    let task: Task | undefined;
    await expect
      .poll(async () => {
        const columns = await core.commands.listBoard();
        task = columns
          .flatMap((column) => column.groups.flatMap((group) => group.tasks))
          .find((entry) => entry.title === "First task");
        return task?.id ?? null;
      })
      .not.toBeNull();
    expect(task).toMatchObject({
      repositoryId: "github.com/acme/beta",
      harness: "claude-code",
    });
  } finally {
    await first.app.close().catch(() => {});
  }

  // Relaunch: straight into the app; Settings… → "Run setup again" reopens
  // the wizard.
  const second = await launch({
    HARBORMASTER_PI_COMMAND: writeVersionPi(),
    GIT_ALLOW_PROTOCOL: "file",
    FAKE_GH_AUTH_DELAY: "2",
  });
  try {
    await expect(second.window.getByTestId("workspace-view")).toBeVisible();
    await expect(second.window.getByTestId("onboarding")).toHaveCount(0);
    await second.app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("settings")?.click();
    });
    await second.window.getByTestId("settings-run-setup").click();
    await expect(second.window.getByTestId("onboarding")).toBeVisible();
    await expect(second.window.getByTestId("onboarding-code-root")).toHaveValue(
      codeRoot,
    );

    // Setup screen → "Check setup": grouped doctor checks with statuses.
    for (const step of ["agent", "review", "github", "concepts"]) {
      await second.window.getByTestId("onboarding-next").click();
      await expect(second.window.getByTestId("onboarding")).toHaveAttribute(
        "data-step",
        step,
      );
    }
    await second.window.getByTestId("onboarding-check-setup").click();
    // The fake Pi is below Pi's minVersion (P7): not the default agent
    // (Claude Code is), so warn, with Pi's own upgrade command.
    const pi = second.window.getByTestId("doctor-check-agents.pi");
    await expect(pi).toHaveAttribute("data-status", "warn");
    await expect(pi).toContainText("Pi 0.0.9 is older than the minimum 1.0.0");
    await expect(pi).toContainText(
      "npm install -g @earendil-works/pi-coding-agent@latest",
    );
    const remote = second.window.getByTestId("doctor-check-repos.remote");
    await expect(remote).toHaveAttribute("data-status", "fail");
    await expect(
      second.window.getByTestId("doctor-check-item-github.com/acme/beta"),
    ).toHaveAttribute("data-status", "fail");
    await expect(remote).toContainText(
      "github.com/acme/alpha: not probed (no active task)",
    );
    await expect(remote).toContainText("→ Check the network");
    await expect(
      second.window.getByTestId("setup-check-headline"),
    ).toContainText("failed");
    await second.window.getByTestId("setup-check-rerun").click();
    // While it runs, each group shows a spinner (the remote probes are slow).
    await expect(
      second.window.getByTestId("setup-check-running-repos"),
    ).toContainText("probing remotes (up to 20 s)");
    await expect(pi).toHaveAttribute("data-status", "warn");
    await second.window.getByTestId("onboarding-close").click();
    await expect(second.window.getByTestId("onboarding")).toHaveCount(0);
    await expect(second.window.getByTestId("workspace-view")).toBeVisible();
  } finally {
    await second.app.close().catch(() => {});
  }
});
