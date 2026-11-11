// Inbox view e2e (docs/release-plan.md "Inbox"): one launch, one fixture.
// Two chats run the OSC 7501 fake agent: "Asker" reports `blocked` with a
// question (Priority), "Idler" reports `idle` (Other). Two messages between
// them await approval (Priority), and core's persisted inbox holds a
// review-request rule item (Priority, unbound) and a `priority: false` rule
// item (Other). Covers the Priority / Other split and the sidebar badge,
// J/K/arrows, A / R / D / H / C, Tab, Cmd+I and Esc back to the previous
// view; "Create review task" creates a reviewer task bound to the PR
// (a fake `gh` answers the PR lookup). Results are read back through core.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Core, createCore } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { chooseWhere } from "./composer";
import { fakePiPid, STATUS_CONTROL_FILE, writeStatusPi } from "./fake-pi";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");
const REPO_ID = "github.com/test/fixture";
const PR_URL = "https://github.com/test/fixture/pull/7";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
let external: Core;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-inbox-"));
  stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const codeRoot = path.join(root, "Code");
  const checkout = path.join(codeRoot, "fixture-repo");
  mkdirSync(codeRoot, { recursive: true });
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
    JSON.stringify({ automation: false, codeRoot, branchPrefix: "" }),
  );

  // Fake gh: the PR lookup (`api graphql` with `number=`) answers PR #7 by
  // someone else; every other call finds nothing.
  const fakeGh = path.join(root, "fake-gh");
  const pr = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 7,
          url: PR_URL,
          state: "OPEN",
          isDraft: false,
          author: { login: "octo" },
          headRefName: "feature-login",
          headRefOid: "abc123",
          baseRefName: "main",
          viewerDidAuthor: false,
        },
      },
    },
  });
  writeFileSync(
    fakeGh,
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *number=*) printf '%s' '${pr}' ;;`,
      `  "api graphql"*) printf '%s' '{"data":{"repository":{}}}' ;;`,
      "  *) printf '[]' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGh, 0o755);

  // Persisted rule items, as the rules engine's `inbox` action writes them.
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
          body: "test/fixture#7 by **octo**",
          buttons: [
            {
              id: "b0",
              label: "Create review task",
              action: "createTask",
              with: {
                title: "Review: Fix login",
                pr: PR_URL,
                role: "reviewer",
              },
            },
            { id: "b1", label: "Dismiss", action: "dismiss" },
          ],
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

  external = createCore({ stateDir });
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      HARBORMASTER_PI_COMMAND: writeStatusPi(root),
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

/** Starts a chat running the 7501 fake agent; returns its id and a reporter. */
async function startAgentChat(
  title: string,
): Promise<{ id: string; report: (body: string) => void }> {
  await window.getByTestId("sidebar-new-task-button").click();
  await window.getByTestId("new-task-title-input").fill(title);
  await chooseWhere(window, "none");
  await window.getByTestId("new-task-submit").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);
  const row = window
    .locator('[data-testid^="sidebar-task-row-"]')
    .filter({ hasText: title });
  const id = ((await row.getAttribute("data-testid")) ?? "").replace(
    "sidebar-task-row-",
    "",
  );
  await fakePiPid(stateDir, id);
  const scratch = path.join(stateDir, "scratch", id);
  return {
    id,
    report: (body) =>
      writeFileSync(path.join(scratch, STATUS_CONTROL_FILE), body),
  };
}

const rows = (): Locator => window.locator('[data-testid^="inbox-row-"]');
const row = (kind: string, text?: string): Locator => {
  const byKind = window.locator(
    `[data-testid^="inbox-row-"][data-kind="${kind}"]`,
  );
  return text ? byKind.filter({ hasText: text }) : byKind;
};

test("Priority / Other, badge, keys (J/K, A, R, D, C, H, Tab, Esc) and Create review task", async () => {
  const asker = await startAgentChat("Asker");
  const idler = await startAgentChat("Idler");
  asker.report(
    `state=blocked:kind=question:msg=${Buffer.from("Which database?").toString("base64")}`,
  );
  idler.report("state=idle");
  const first = await external.commands.sendTaskMessage({
    from: { kind: "task", taskId: asker.id },
    targetTaskId: idler.id,
    text: "please rebase",
  });
  const second = await external.commands.sendTaskMessage({
    from: { kind: "task", taskId: asker.id },
    targetTaskId: idler.id,
    text: "and drop the debug logs",
  });
  expect(second.message.status).toBe("awaiting_approval");

  // Badge = Priority: the question, two approvals, the review request.
  await expect(window.getByTestId("inbox-button-count")).toHaveText("4", {
    timeout: 15_000,
  });

  // Cmd+I from the workspace opens the inbox in place of the workspace.
  await window.keyboard.press(`${MOD}+i`);
  await expect(window.getByTestId("inbox-view")).toBeVisible();
  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(window.getByTestId("inbox-tab-priority-count")).toHaveText("4");
  await expect(window.getByTestId("inbox-tab-other-count")).toHaveText("2");
  await expect(row("asked", "Which database?")).toBeVisible();
  await expect(row("approval")).toHaveCount(2);
  await expect(row("rule", "Review requested: Fix login")).toBeVisible();
  await expect(row("idle")).toHaveCount(0);

  // J / ArrowDown / K move the selection in list order.
  await expect(rows().nth(0)).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("j");
  await expect(rows().nth(1)).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("ArrowDown");
  await expect(rows().nth(2)).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("k");
  await expect(rows().nth(1)).toHaveAttribute("data-selected", "true");

  // A approves, R rejects (the selected approval).
  const firstRow = window.getByTestId(`inbox-row-approval:${first.message.id}`);
  await firstRow.click();
  await expect(firstRow).toHaveAttribute("data-selected", "true");
  await window.keyboard.press("a");
  await expect(firstRow).toHaveCount(0);
  const secondRow = window.getByTestId(
    `inbox-row-approval:${second.message.id}`,
  );
  await secondRow.click();
  await window.keyboard.press("r");
  await expect(secondRow).toHaveCount(0);
  const statuses = Object.fromEntries(
    (await external.commands.listMessages()).map((m) => [m.id, m.status]),
  );
  expect(statuses[first.message.id]).toBe("pending");
  expect(statuses[second.message.id]).toBe("rejected");

  // D on a live question does nothing: it leaves when the agent's state does.
  await row("asked").click();
  await window.keyboard.press("d");
  await expect(row("asked")).toBeVisible();

  // C on the review request: a reviewer task bound to the PR's head branch.
  await row("rule", "Review requested").click();
  await expect(window.getByTestId("inbox-detail-body")).toContainText("octo");
  await window.keyboard.press("c");
  await expect(row("rule", "Review requested")).toHaveCount(0);
  await expect
    .poll(async () => {
      const tasks = (await external.commands.listBoard()).flatMap((column) =>
        column.groups.flatMap((group) => group.tasks),
      );
      const review = tasks.find((task) => task.title === "Review: Fix login");
      return review
        ? {
            repositoryId: review.repositoryId,
            branch: review.branch,
            number: review.pr?.number,
            role: review.pr?.role,
          }
        : null;
    })
    .toEqual({
      repositoryId: REPO_ID,
      branch: "feature-login",
      number: 7,
      role: "reviewer",
    });
  await expect(window.getByTestId("inbox-button-count")).toHaveText("1");

  // Tab: Other holds the plain "your move" and the rule's FYI.
  await window.keyboard.press("Tab");
  await expect(window.getByTestId("inbox-view")).toHaveAttribute(
    "data-tab",
    "other",
  );
  await expect(row("idle")).toBeVisible();
  await row("idle").click();
  await window.keyboard.press("d");
  await expect(row("idle")).toHaveCount(0);

  // H snoozes (core keeps the time on a persisted item).
  await row("rule", "Deployed to staging").click();
  await window.keyboard.press("h");
  await expect(window.getByTestId("inbox-snooze-picker")).toBeVisible();
  await window.keyboard.press("1");
  await expect(row("rule", "Deployed to staging")).toHaveCount(0);
  const fyi = (
    await external.commands.listInbox({ includeSnoozed: true })
  ).find((item) => item.id === "fyi-1");
  expect(fyi?.snoozedUntil).toBeDefined();
  expect(fyi?.resolvedAt).toBeUndefined();
  await expect(window.getByTestId("inbox-empty")).toBeVisible();

  // Esc returns to the view the inbox was opened from (workspace, then board).
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("inbox-view")).toHaveCount(0);
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-inbox-button-count")).toHaveText("1");
  await window.keyboard.press(`${MOD}+i`);
  await expect(window.getByTestId("inbox-view")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("board-view")).toBeVisible();
  await expect(window.getByTestId("inbox-view")).toHaveCount(0);
});
