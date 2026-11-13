// "Open in …" e2e (see main/open-in.ts, components/OpenInButton.tsx): a
// repository task's worktree folder opens in the chosen app. The launcher is
// stubbed by HARBORMASTER_OPEN_IN_STUB=<file>: main appends the argv it
// WOULD run (one JSON array per line) instead of spawning anything, and
// offers the whole catalog so the test never depends on installed apps.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  type Page,
  test,
} from "@playwright/test";
import { chooseWhere } from "./composer";
import { writeShellPi } from "./fake-pi";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

let app: ElectronApplication;
let window: Page;
let root: string;
let codeRoot: string;
let stubFile: string;
const mainProcessErrors: string[] = [];

function stubLines(): string[][] {
  if (!existsSync(stubFile)) return [];
  return readFileSync(stubFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-open-in-"));
  const stateDir = path.join(root, "state");
  codeRoot = path.join(root, "Code");
  stubFile = path.join(root, "open-in-calls.jsonl");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });

  const repoCheckout = path.join(codeRoot, "fixture-repo");
  git(["init", "-q", "-b", "main", repoCheckout]);
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
    repoCheckout,
  );
  git(
    ["remote", "add", "origin", "https://github.com/test/open-in-fixture.git"],
    repoCheckout,
  );
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: true, codeRoot, branchPrefix: "" }),
  );

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: writeShellPi(root),
      HARBORMASTER_OPEN_IN_STUB: stubFile,
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text))
      mainProcessErrors.push(text.trim());
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

test("opens the task's worktree folder in the chosen app, remembers it, copies the path, refuses other paths", async () => {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill("Open In Task");
  await chooseWhere(window, "github.com/test/open-in-fixture");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  const row = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: "Open In Task" });
  await expect(row).toHaveAttribute("data-selected", "true");
  const taskId = (await row.getAttribute("data-task-id")) ?? "";
  const workspace = window.getByTestId(`task-workspace-${taskId}`);
  await expect(workspace).toBeVisible();

  const worktreesDir = path.join(codeRoot, ".harbormaster-worktrees");
  await expect.poll(() => readdirSync(worktreesDir).length).toBe(1);
  const worktreeName = readdirSync(worktreesDir)[0] ?? "";
  const isWorktree = (arg: string | undefined): boolean =>
    !!arg?.endsWith(
      `${path.sep}.harbormaster-worktrees${path.sep}${worktreeName}`,
    );

  // The split button shows, enabled once the binding resolves (no last app
  // yet: the default is the first installed editor, VS Code in the stubbed
  // catalog, never Finder).
  const main = workspace.getByTestId("open-in-main");
  await expect(main).toBeEnabled();
  await expect(main).toHaveText("Open in VS Code");

  // Choosing Cursor from the dropdown opens the folder in Cursor.
  await workspace.getByTestId("open-in-menu-trigger").click();
  const menu = window.getByTestId("open-in-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Editors");
  await expect(menu).toContainText("Terminals");
  await menu.getByTestId("open-in-app-cursor").click();
  await expect.poll(() => stubLines().length).toBe(1);
  const [cursorArgv] = stubLines();
  expect(cursorArgv?.slice(0, 3)).toEqual(["open", "-a", "Cursor"]);
  expect(cursorArgv).toHaveLength(4);
  expect(isWorktree(cursorArgv?.[3])).toBe(true);

  // The choice persists as the default across a reload; the main part
  // reopens in it.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await row.click();
  await expect(workspace).toBeVisible();
  await expect(main).toHaveText("Open in Cursor");
  await expect(main).toHaveAttribute("data-app-id", "cursor");
  await main.click();
  await expect.poll(() => stubLines().length).toBe(2);
  expect(stubLines()[1]).toEqual(cursorArgv);

  // The sidebar row's context menu: "Open in Cursor" plus an "Open in…" flyout.
  await row.click({ button: "right" });
  const contextMenu = window.getByTestId("sidebar-row-context-menu");
  const openInItem = contextMenu.getByTestId(
    "sidebar-row-context-menu-item-open-in",
  );
  await expect(openInItem).toBeVisible({ timeout: 5_000 });
  await expect(
    contextMenu.getByTestId("sidebar-row-context-menu-item-open-in-default"),
  ).toHaveText("Open in Cursor");
  await openInItem.hover();
  await contextMenu
    .getByTestId("sidebar-row-context-menu-item-open-in-ghostty")
    .click();
  await expect(contextMenu).toHaveCount(0);
  await expect.poll(() => stubLines().length).toBe(3);
  const ghosttyArgv = stubLines()[2];
  expect(ghosttyArgv?.slice(0, 3)).toEqual(["open", "-a", "Ghostty"]);
  expect(isWorktree(ghosttyArgv?.[3])).toBe(true);
  await expect(main).toHaveText("Open in Ghostty");

  // Copy path copies the worktree folder (through main's clipboard; keep
  // the developer's clipboard).
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await workspace.getByTestId("open-in-menu-trigger").click();
    await window.getByTestId("open-in-copy-path").click();
    await expect
      .poll(async () =>
        isWorktree(await app.evaluate(({ clipboard }) => clipboard.readText())),
      )
      .toBe(true);
  } finally {
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      previous,
    );
  }

  // Main refuses a path outside the allowlist, and an unknown app id, and
  // runs nothing for either.
  // `root` is a real directory just above the allowed code root.
  const refused = await window.evaluate(
    ([outside, worktree]) =>
      Promise.all([
        window.harbormaster.app.openIn("/etc", "cursor"),
        window.harbormaster.app.openIn(outside, "finder"),
        window.harbormaster.app.openIn(worktree, "not-an-app"),
      ]),
    [root, path.join(worktreesDir, worktreeName)] as const,
  );
  expect(refused.map((result) => result.ok)).toEqual([false, false, false]);
  expect(stubLines()).toHaveLength(3);
});
