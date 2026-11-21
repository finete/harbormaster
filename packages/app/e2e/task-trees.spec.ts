// Task trees (docs/task-trees.md decisions 11 and 12): a three-level tree
// renders one indent per level on the board and the sidebar rail, and the
// Done dialog's "Also stop these N tasks" checkbox stops the agents of the
// tasks below (and only those, only when ticked; the tasks stay on the board).
// One fixture/launch: real core + a git repo; the fake pi records its pid per
// worktree and idles so a stop is observable as a dead process.
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
  type Page,
  test,
} from "@playwright/test";
import { selectCard } from "./board-gestures";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const REPO_ID = "github.com/test/fixture";

let app: ElectronApplication;
let window: Page;
let root: string;
let pidLog: string;
const mainProcessErrors: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

/** Launches a task through the real launch primitive; `from` makes it a child. */
function launch(title: string, from?: string): Promise<string> {
  return window.evaluate(
    async ({ title, from, repositoryId }) => {
      const task = await window.harbormaster.core.launchTask({
        relation: from ? "child" : "standalone",
        ...(from ? { fromTaskId: from } : {}),
        title,
        prompt: `${title} work`,
        repository: { repositoryId },
      } as never);
      return task.id;
    },
    { title, from, repositoryId: REPO_ID },
  );
}

/** The pid the fake pi logged for the worktree whose path contains `slug`. */
function pidFor(slug: string): number | undefined {
  try {
    const line = readFileSync(pidLog, "utf8")
      .split("\n")
      .find((entry) => entry.includes(slug));
    const match = line?.match(/pid:(\d+)/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Shows the board (the Board row toggles back when it is already open). */
async function showBoard(): Promise<void> {
  if (!(await window.getByTestId("board-view").isVisible())) {
    await window.getByTestId("board-button").click();
  }
  await expect(window.getByTestId("board-view")).toBeVisible();
}

async function askDone(taskId: string): Promise<void> {
  await showBoard();
  await selectCard(window, taskId);
  await window.keyboard.press("x");
  await expect(window.getByTestId("confirm-dialog")).toBeVisible();
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-trees-"));
  const stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  const checkout = path.join(codeRoot, "fixture");
  git(["init", "-q", "-b", "main", checkout], root);
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
    checkout,
  );
  git(
    ["remote", "add", "origin", "https://github.com/test/fixture.git"],
    checkout,
  );
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({
      automation: false,
      codeRoot,
      branchPrefix: "",
      // Every launch starts at once (a fake pi never reports presence).
      launch: { maxConcurrent: 20 },
    }),
  );
  pidLog = path.join(root, "pi-pids.log");
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'printf "cwd:%s pid:%s\\n" "$PWD" "$$" >> "$PI_PID_LOG"',
      "while true; do sleep 3600; done",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: fakePi,
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      PI_PID_LOG: pidLog,
    },
  });
  const onChunk = (chunk: Buffer): void => {
    if (/\[main] uncaughtException/i.test(chunk.toString())) {
      mainProcessErrors.push(chunk.toString());
    }
  };
  app.process().stdout?.on("data", onChunk);
  app.process().stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("a three-level tree draws one indent per level on the board and the rail", async () => {
  const root1 = await launch("Tree One Root");
  const kid = await launch("Tree One Kid", root1);
  const grand = await launch("Tree One Grand", kid);
  await showBoard();
  for (const [id, indent] of [
    [root1, null],
    [kid, "1"],
    [grand, "2"],
  ] as const) {
    const card = window.getByTestId(`card-${id}`);
    await expect(card).toBeVisible();
    if (indent === null) {
      await expect(card).not.toHaveAttribute("data-lineage-indent", /.*/);
    } else {
      await expect(card).toHaveAttribute("data-lineage-indent", indent);
    }
  }
  // The rail: open the two nested tasks from their cards.
  for (const id of [grand, kid, root1]) {
    await showBoard();
    await window.getByTestId(`card-${id}`).click();
    await expect(window.getByTestId(`sidebar-task-row-${id}`)).toBeVisible();
  }
  const indentOf = (id: string) =>
    window
      .getByTestId(`sidebar-task-row-${id}`)
      .locator("xpath=..")
      .getAttribute("data-lineage-indent");
  expect(await indentOf(root1)).toBeNull();
  expect(await indentOf(kid)).toBe("1");
  expect(await indentOf(grand)).toBe("2");
});

test("Done's 'Also stop these N tasks' is off every time it opens and stops only the agents below, leaving the tasks on the board", async () => {
  const top = await launch("Stop Top");
  const mid = await launch("Stop Mid", top);
  const leaf = await launch("Stop Leaf", mid);
  const topB = await launch("Keep Top");
  const kidB = await launch("Keep Kid", topB);
  await expect.poll(() => pidFor("stop-leaf")).toBeDefined();
  await expect.poll(() => pidFor("keep-kid")).toBeDefined();
  const leafPid = pidFor("stop-leaf") as number;
  const midPid = pidFor("stop-mid") as number;
  const kidBPid = pidFor("keep-kid") as number;

  // Ticking and cancelling leaves nothing behind: the next open is unchecked.
  await askDone(top);
  const box = window.getByTestId("done-stop-descendants");
  await expect(window.getByTestId("confirm-dialog-line")).toHaveCount(2);
  await expect(box).not.toBeChecked();
  await expect(
    window.getByTestId("confirm-dialog-option-warning"),
  ).toContainText("interrupted mid-work");
  await box.check();
  await window.getByTestId("confirm-dialog-cancel").click();
  await expect(window.getByTestId("confirm-dialog")).toHaveCount(0);
  expect(alive(leafPid)).toBe(true);
  await askDone(top);
  await expect(window.getByTestId("done-stop-descendants")).not.toBeChecked();
  await window.getByTestId("done-stop-descendants").check();
  await window.getByTestId("confirm-dialog-confirm").click();
  // Then the usual "Mark done?" question.
  await expect(
    window.getByRole("heading", { name: "Mark done?" }),
  ).toBeVisible();
  await window.getByTestId("confirm-dialog-confirm").click();

  await expect(
    window
      .getByTestId("column-done-cards")
      .locator(`[data-testid="card-${top}"]`),
  ).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => alive(leafPid)).toBe(false);
  await expect.poll(() => alive(midPid)).toBe(false);
  // Stopped, not finished: both stay in Working.
  for (const id of [mid, leaf]) {
    await expect(
      window
        .getByTestId("column-working-cards")
        .locator(`[data-testid="card-${id}"]`),
    ).toBeVisible();
  }

  // Unticked (the default): the agents below keep running.
  await askDone(topB);
  await window.getByTestId("confirm-dialog-confirm").click();
  await expect(
    window.getByRole("heading", { name: "Mark done?" }),
  ).toBeVisible();
  await window.getByTestId("confirm-dialog-confirm").click();
  await expect(
    window
      .getByTestId("column-done-cards")
      .locator(`[data-testid="card-${topB}"]`),
  ).toBeVisible({ timeout: 15_000 });
  expect(alive(kidBPid)).toBe(true);
  await expect(
    window
      .getByTestId("column-working-cards")
      .locator(`[data-testid="card-${kidB}"]`),
  ).toBeVisible();
});
