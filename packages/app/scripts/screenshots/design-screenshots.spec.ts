// Design-system screenshots (docs/design-system.md), not part of the e2e
// suite: run on demand to compare the app against
// docs/design-system-reference.png. Two offscreen launches (main UI, then
// the first-run wizard); PNGs land in <repo>/reports/screenshots/.
//
//   npx electron-vite build
//   npx playwright test -c scripts/screenshots/playwright.config.ts
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
  type Page,
  test,
} from "@playwright/test";
import { writeShellPi } from "../../e2e/fake-pi";

const mainEntry = path.join(__dirname, "..", "..", "out", "main", "index.js");
const OUT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "reports",
  "screenshots",
);
const REPO_ID = "github.com/acme/arnac";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

let root: string;
const apps: ElectronApplication[] = [];

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

function seedRepository(codeRoot: string, name: string): void {
  const dir = path.join(codeRoot, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main", dir], root);
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

/** `gh`: signed in; PR #26873 open + approved by someone else. */
function writeFakeGh(): string {
  const file = path.join(root, "fake-gh");
  const pr = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 26873,
          url: "https://github.com/acme/arnac/pull/26873",
          state: "OPEN",
          isDraft: false,
          reviewDecision: "APPROVED",
          author: { login: "octo" },
          headRefName: "moshe/dev-18921-fe-show-jito-tip",
          headRefOid: "abc123",
          baseRefName: "main",
          viewerDidAuthor: true,
        },
      },
    },
  });
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "auth status" ]; then',
      "  echo 'github.com'",
      "  echo '  ✓ Logged in to github.com account octo-e2e (keyring)'",
      "  exit 0",
      "fi",
      'case "$*" in',
      `  *number=*) printf '%s' '${pr}' ;;`,
      `  "api graphql"*) printf '%s' '{"data":{"repository":{}}}' ;;`,
      "  *) printf '[]' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

async function launch(env: Record<string, string>): Promise<Page> {
  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...(process.env as Record<string, string>),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_UPDATE_CHECK: "off",
      ...env,
    },
  });
  apps.push(app);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1600, height: 900 });
  return window;
}

test.beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "harbormaster-shots-")));
  mkdirSync(OUT, { recursive: true });
});

test.afterAll(async () => {
  for (const app of apps) await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("workspace, board, inbox", async () => {
  test.setTimeout(120_000);
  const stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  seedRepository(codeRoot, "arnac");
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: false, codeRoot, branchPrefix: "moshe/" }),
  );
  const fakeGh = writeFakeGh();
  process.env.HARBORMASTER_GH_COMMAND = fakeGh;
  mkdirSync(path.join(stateDir, "inbox"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "inbox", "items.json"),
    JSON.stringify({
      version: 1,
      items: [
        {
          id: "review-7",
          kind: "rule",
          source: "github",
          ruleId: "review-requested-inbox",
          title: "Review requested: Fix login",
          body: "acme/arnac#7 by **octo**",
          buttons: [{ id: "b1", label: "Dismiss", action: "dismiss" }],
          createdAt: new Date().toISOString(),
        },
        {
          id: "fyi-1",
          kind: "rule",
          source: "version-endpoint",
          title: "Deployed to staging",
          priority: false,
          buttons: [],
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );

  const core = createCore({ stateDir });
  await core.commands.createTask({
    title: "Fix Jito MEV",
    initialPrompt: "",
    repositoryId: REPO_ID,
  });
  await core.commands.createTask({
    title: "Untitled spike",
    initialPrompt: "",
  });
  try {
    await core.commands.createTask({
      title: "DEV-18921 FE: show Jito tip in mined swap fee",
      initialPrompt: "",
      repositoryId: REPO_ID,
      pullRequest: 26873,
    });
  } catch {
    // PR binding is best effort here; the board shot still has cards.
  }

  const window = await launch({
    HARBORMASTER_STATE_DIR: stateDir,
    HARBORMASTER_USER_DATA_DIR: path.join(root, "profile-main"),
    HARBORMASTER_PI_COMMAND: writeShellPi(root),
    HARBORMASTER_GH_COMMAND: fakeGh,
  });
  await window.getByTestId("sidebar").waitFor();

  // Board, with a card keyboard-selected.
  await window.getByTestId("board-button").first().click();
  await expect(window.getByTestId("board-view")).toBeVisible();
  await expect(window.locator('[data-testid^="card-"]').first()).toBeVisible();
  await window.keyboard.press("ArrowDown");
  await window.screenshot({ path: path.join(OUT, "board.png") });

  // Workspace: open the repo task, start it, add a second terminal tab.
  await window
    .locator('[data-testid^="card-"]')
    .filter({ hasText: "Fix Jito MEV" })
    .click();
  const startButton = window.locator('[data-testid^="start-task-button-"]');
  await expect(startButton.first()).toBeVisible();
  await startButton.first().click();
  await expect(window.getByTestId("terminal-tab").first()).toBeVisible();
  await window.getByTestId("add-terminal-button").click();
  await expect(window.getByTestId("terminal-tab")).toHaveCount(2);
  await window.getByTestId("terminal-tab").first().hover();
  await window.screenshot({ path: path.join(OUT, "workspace.png") });
  const header = window.getByTestId("workspace-header");
  const headerBox = await header.boundingBox();
  if (headerBox) {
    await window.screenshot({
      path: path.join(OUT, "workspace-header-tabs.png"),
      clip: {
        x: headerBox.x,
        y: headerBox.y,
        width: headerBox.width,
        height: headerBox.height + 120,
      },
    });
  }

  // Inbox (Cmd+I).
  await window.keyboard.press(`${MOD}+i`);
  await expect(window.getByTestId("inbox-view")).toBeVisible();
  await expect(
    window.locator('[data-testid^="inbox-row-"]').first(),
  ).toBeVisible();
  await window.screenshot({ path: path.join(OUT, "inbox.png") });
});

test("new-task composer at 1200px and 800px", async () => {
  test.setTimeout(120_000);
  const stateDir = path.join(root, "state-composer");
  const codeRoot = path.join(root, "Code-composer");
  mkdirSync(stateDir, { recursive: true });
  seedRepository(codeRoot, "arnac");
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: false, codeRoot, branchPrefix: "moshe/" }),
  );
  const fakeGh = writeFakeGh();
  const window = await launch({
    HARBORMASTER_STATE_DIR: stateDir,
    HARBORMASTER_USER_DATA_DIR: path.join(root, "profile-composer"),
    HARBORMASTER_PI_COMMAND: writeShellPi(root),
    HARBORMASTER_GH_COMMAND: fakeGh,
  });
  await window.getByTestId("sidebar").waitFor();
  await window.keyboard.press(`${MOD}+n`);
  const composer = window.getByTestId("new-task-composer");
  await expect(composer).toBeVisible();
  await window.getByTestId("new-task-where").click();
  await window
    .locator(
      `[data-testid="new-task-where-option"][data-where="repo:${REPO_ID}"]`,
    )
    .first()
    .click();
  await expect(window.getByTestId("new-task-base")).toBeVisible();
  await window
    .getByTestId("new-task-prompt-input")
    .fill("Show the Jito tip in the mined swap fee breakdown");
  for (const width of [1200, 800]) {
    await window.setViewportSize({ width, height: 800 });
    await window.screenshot({
      path: path.join(OUT, `composer-task-${width}.png`),
    });
  }
  await window.setViewportSize({ width: 1200, height: 800 });
  await window.getByTestId("new-task-options").click();
  await expect(window.getByTestId("new-task-options-menu")).toBeVisible();
  await window.screenshot({ path: path.join(OUT, "composer-options.png") });
  await window.keyboard.press("Escape");
  await window.getByTestId("new-task-attach-pr").click();
  await expect(window.getByTestId("new-task-pr-url-input")).toBeVisible();
  await window.screenshot({ path: path.join(OUT, "composer-attach-pr.png") });
  await window.getByTestId("new-task-mode-review").click();
  await window
    .getByTestId("new-task-pr-url-input")
    .fill("https://github.com/acme/arnac/pull/26873");
  await window
    .getByTestId("new-task-pr-card")
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  for (const width of [1200, 800]) {
    await window.setViewportSize({ width, height: 800 });
    await window.screenshot({
      path: path.join(OUT, `composer-review-${width}.png`),
    });
  }
});

test("wizard agent step", async () => {
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state-wizard");
  mkdirSync(stateDir, { recursive: true });
  seedRepository(path.join(home, "Code"), "arnac");
  const window = await launch({
    HOME: home,
    HARBORMASTER_SKIP_ONBOARDING: "0",
    HARBORMASTER_STATE_DIR: stateDir,
    HARBORMASTER_USER_DATA_DIR: path.join(root, "profile-wizard"),
    HARBORMASTER_PI_COMMAND: path.join(root, "no-such-pi"),
    HARBORMASTER_CLAUDE_COMMAND: path.join(root, "no-such-claude"),
    HARBORMASTER_GH_COMMAND: writeFakeGh(),
  });
  const wizard = window.getByTestId("onboarding");
  await expect(wizard).toHaveAttribute("data-step", "code");
  await expect(window.getByTestId("onboarding-repo").first()).toBeVisible();
  await window.getByTestId("onboarding-next").click();
  await expect(wizard).toHaveAttribute("data-step", "agent");
  await expect(window.getByTestId("onboarding-agent-pi-status")).not.toHaveText(
    "Detecting…",
  );
  await window.screenshot({ path: path.join(OUT, "wizard-agent.png") });
});
