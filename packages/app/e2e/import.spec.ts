// Import existing work (docs/import.md): "+ New" → Import… over the recorded
// agent-session fixtures (temp copies, never the real stores: the app reads
// HARBORMASTER_IMPORT_HOME / HARBORMASTER_IMPORT_PROCESSES_FILE). Two
// repositories: alpha (a Pi and a Claude Code session in one worktree: the
// "+1 other session" picker) and beta (a Codex session a fake process table
// says is running: disabled with its reason, Check again, Fork instead).
// Tick, edit a title, pick the Pi session, fork beta → Import → both tasks
// are on the board → the inbox summary's Undo import removes them (nothing was opened) and the list offers them
// again. A second import of alpha: Show on board highlights it; marked Done: its External worktree is
// kept ("isn't Harbormaster's"), then "Remove worktree…" removes the folder
// and keeps the branch.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { writeShellPi } from "./fake-pi";
import { materializeFixture, seedWorktreeRepo } from "./import-fixtures";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

let root: string;
let alpha: string;
let beta: string;
let app: ElectronApplication;
let window: Page;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "hm-e2e-import-")));
  const home = path.join(root, "home");
  alpha = path.join(root, "alpha");
  beta = path.join(root, "beta");
  mkdirSync(home);
  seedWorktreeRepo(alpha, "alpha", "feature/alpha");
  seedWorktreeRepo(beta, "beta", "feature/beta");
  materializeFixture("pi", home, alpha);
  materializeFixture("claude-code", home, alpha);
  materializeFixture("codex", home, beta);
  const processes = path.join(root, "processes.json");
  writeFileSync(
    processes,
    JSON.stringify([
      { harness: "codex", pid: 424242, cwd: path.join(beta, "wt") },
    ]),
  );
  const fakeGh = path.join(root, "fake-gh");
  writeFileSync(fakeGh, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: path.join(root, "state"),
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_IMPORT_HOME: home,
      HARBORMASTER_IMPORT_PROCESSES_FILE: processes,
      // A task opened here gets a shell, never the real agent.
      HARBORMASTER_PI_COMMAND: writeShellPi(root),
      HARBORMASTER_GH_COMMAND: fakeGh,
    },
  });
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) mainProcessErrors.push(text);
  };
  app.process().stdout?.on("data", onChunk);
  app.process().stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.getByTestId("sidebar").waitFor();
});

test.afterAll(async () => {
  await app?.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

const group = (name: string) =>
  window.getByTestId(`import-group-github.com/acme/${name}`);
const row = (name: string) =>
  group(name).locator('[data-testid^="import-row-"]');

async function openImportDialog(): Promise<void> {
  // The board button toggles: only press it when the board is not showing.
  if (!(await window.getByTestId("board-new-menu-trigger").isVisible())) {
    await window.getByTestId("board-button").click();
  }
  await window.getByTestId("board-new-menu-trigger").click();
  await window.getByTestId("board-new-import").click();
  await expect(window.getByTestId("import-dialog")).toBeVisible();
  await expect(row("alpha")).toHaveCount(1);
}

test("Import… lists, imports, shows on the board, and Undo import removes the tasks", async () => {
  await openImportDialog();

  // alpha: the newest session is bound, the other is one click away; last 7 days → pre-ticked.
  await expect(row("alpha")).toHaveAttribute("data-checked", "true");
  await expect(row("alpha").getByTestId("import-hint")).toHaveText(
    "from session title",
  );
  await expect(row("alpha")).toContainText("+1 other session");

  // beta: the Codex session is running: disabled, with the reason, Check again and Fork instead.
  await expect(row("beta")).toHaveAttribute("data-blocked", "running");
  await expect(row("beta")).toHaveAttribute("data-checked", "false");
  await expect(row("beta").getByTestId("import-running-message")).toContainText(
    "Running",
  );
  await expect(
    row("beta").locator('[data-testid^="import-check-again-"]'),
  ).toBeVisible();
  await expect(window.getByTestId("import-submit")).toHaveText("Import 1 task");

  // Edit alpha's title and bind its Pi session through the picker.
  await row("alpha")
    .locator('[data-testid^="import-title-"]')
    .fill("Alpha work");
  await row("alpha").locator('[data-testid^="import-sessions-"]').click();
  await window
    .getByTestId("import-session-picker")
    .locator('button:has([data-harness="pi"])')
    .click();
  await expect(
    row("alpha").locator('[data-testid="import-agent-icon"]').first(),
  ).toHaveAttribute("data-harness", "pi");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("import-session-picker")).toHaveCount(0);

  // Fork instead ticks the running row.
  await row("beta").locator('[data-testid^="import-fork-"]').click();
  await expect(row("beta")).toHaveAttribute("data-checked", "true");
  await expect(window.getByTestId("import-submit")).toHaveText(
    "Import 2 tasks",
  );
  await window.getByTestId("import-submit").click();
  await expect(window.getByTestId("import-dialog")).toHaveCount(0);

  // Both are Working cards; no toast, the inbox item is the summary.
  const working = window.getByTestId("column-working-cards");
  await expect(working).toContainText("Alpha work");
  await expect(working).toContainText("Import fixture thread");

  // Inbox: the summary item.
  await window.getByTestId("board-inbox-button").click();
  await window.getByTestId("inbox-tab-other").click();
  await window.locator('[data-testid^="inbox-row-"]').first().click();
  await expect(window.getByTestId("inbox-detail")).toContainText(
    "Imported 2 tasks",
  );
  // Undo import: the board forgets both (neither was opened); folders are untouched.
  await window
    .getByTestId("inbox-detail")
    .getByRole("button", { name: "Undo import" })
    .click();
  await window.getByTestId("board-button").click();
  await expect(window.locator("[data-selected]")).toHaveCount(0);
  expect(existsSync(path.join(alpha, "wt"))).toBe(true);
  expect(existsSync(path.join(beta, "wt"))).toBe(true);
});

test("a Done External task keeps its worktree; Remove worktree… removes the folder and keeps the branch", async () => {
  await openImportDialog();
  await expect(row("alpha")).toHaveAttribute("data-checked", "true");
  await row("alpha").locator('[data-testid^="import-sessions-"]').click();
  await window
    .getByTestId("import-session-picker")
    .locator('button:has([data-harness="pi"])')
    .click();
  await window.keyboard.press("Escape");
  // Unticking beta's running row is not needed: it is not ticked. Enter imports.
  await row("alpha").getByRole("checkbox").focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("import-dialog")).toHaveCount(0);

  // The summary's Show on board opens the board and highlights the new card.
  await window.getByTestId("board-inbox-button").click();
  await window.getByTestId("inbox-tab-other").click();
  await window.locator('[data-testid^="inbox-row-"]').first().click();
  await window
    .getByTestId("inbox-detail")
    .getByRole("button", { name: "Show on board" })
    .click();
  await expect(window.locator('[data-highlighted="true"]')).toHaveCount(1);
  const card = window.locator("[data-selected]").first();
  await card.click();
  await window.locator('[data-testid^="to-done-button-"]').click();
  const confirm = window.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("isn't Harbormaster's and will be kept");
  await expect(confirm).not.toContainText("will be removed");
  await window.getByRole("button", { name: "Mark done" }).click();
  await expect(confirm).toHaveCount(0);
  expect(existsSync(path.join(alpha, "wt"))).toBe(true);

  await window.locator('[data-testid^="remove-worktree-button-"]').click();
  await expect(confirm).toContainText("Remove worktree?");
  await expect(confirm).toContainText("will be removed");
  await expect(confirm).toContainText("is kept");
  await window.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect
    .poll(() => existsSync(path.join(alpha, "wt")), { timeout: 15_000 })
    .toBe(false);
  const branches = execFileSync("git", ["branch", "--list", "feature/alpha"], {
    cwd: path.join(alpha, "repo"),
    encoding: "utf8",
  });
  expect(branches).toContain("feature/alpha");
  await expect(
    window.locator('[data-testid^="remove-worktree-button-"]'),
  ).toHaveCount(0);
});
