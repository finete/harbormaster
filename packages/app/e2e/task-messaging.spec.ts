// Task-messaging e2e lane (see /docs/task-messaging.md "App"): the one
// integration seam the approval inbox depends on. Two unrelated tasks are
// seeded through a core instance in this test process (exactly how the Pi
// extension writes: a second core over the app's state dir); a message
// between them takes the approval route, the app's state-dir watcher pushes
// it to the renderer, and the user edits + approves it from the inbox. The
// result is read back through core, not the DOM. `pi` is a tiny fake that
// records its invocations, which also proves the approved message's target
// (no live session) is woken by the background launcher.
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
import { type Core, createCore } from "@harbormaster/core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "playwright/test";

const REPO_ID = "github.com/test/fixture";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
let invokeLogPath: string;
let external: Core;
let senderId: string;
let targetId: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-messaging-"));
  stateDir = path.join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  invokeLogPath = path.join(root, "pi-invocations.log");

  // A real git fixture repo so the target task gets a worktree (a message
  // target with no worktree has nothing to resume).
  const codeRoot = path.join(root, "Code");
  const repoCheckout = path.join(codeRoot, "fixture-repo");
  mkdirSync(codeRoot, { recursive: true });
  git(["init", "-q", "-b", "main", repoCheckout], root);
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
    ["remote", "add", "origin", "https://github.com/test/fixture.git"],
    repoCheckout,
  );
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ automation: false, codeRoot, branchPrefix: "" }),
  );

  // Fake pi: log the invocation, then idle (never claims messages).
  const fakePi = path.join(root, "fake-pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'printf "cwd:%s pid:%s\\n" "$PWD" "$$" >> "$PI_INVOKE_LOG"',
      "while true; do sleep 3600; done",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);

  // Seed before launch, through core (frontends never write state files).
  external = createCore({ stateDir });
  senderId = (
    await external.commands.createTask({
      title: "Sender Task",
      initialPrompt: "",
      start: true,
    })
  ).id;
  targetId = (
    await external.commands.createTask({
      title: "Target Task",
      initialPrompt: "",
      repositoryId: REPO_ID,
      start: true,
    })
  ).id;

  app = await electron.launch({
    args: [path.join(__dirname, "..", "out", "main", "index.js")],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_PI_COMMAND: fakePi,
      HARBORMASTER_PRESENCE_POLL_MS: "250",
      PI_INVOKE_LOG: invokeLogPath,
    },
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.includes("[main] uncaughtException")) mainProcessErrors.push(text);
  });
  window = await app.firstWindow();
  await window.getByTestId("sidebar").waitFor();
});

test.afterAll(async () => {
  await app.close();
  expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("an approval-route message shows in the inbox; editing + approving delivers the edited text", async () => {
  // The Inbox nav row is always there; its count badge only while something awaits approval.
  await expect(
    window.getByTestId("workspace-approval-inbox-button"),
  ).toBeVisible();
  await expect(
    window.getByTestId("workspace-approval-inbox-button-count"),
  ).toHaveCount(0);

  const sent = await external.commands.sendTaskMessage({
    from: { kind: "task", taskId: senderId },
    targetTaskId: targetId,
    text: "please rebase onto main",
  });
  expect(sent.message.status).toBe("awaiting_approval");

  // Pushed by the state-dir watcher (the message was written by another core).
  const workspaceBadge = window.getByTestId("workspace-approval-inbox-button");
  await expect(workspaceBadge).toBeVisible({ timeout: 10_000 });
  await expect(
    window.getByTestId("workspace-approval-inbox-button-count"),
  ).toHaveText("1");

  // Same signal in the board view's header, plus the card chip.
  await window.getByTestId("board-button").click();
  await expect(window.getByTestId("board-view")).toBeVisible();
  await expect(
    window.getByTestId("board-approval-inbox-button-count"),
  ).toHaveText("1");
  await expect(
    window
      .getByTestId(`card-${targetId}`)
      .getByTestId("badge-approval-waiting"),
  ).toBeVisible();

  // Open the inbox: the card names sender -> target and prefills the text.
  await window.getByTestId("board-approval-inbox-button").click();
  const card = window.getByTestId(`approval-card-${sent.message.id}`);
  await expect(card.getByTestId("approval-route")).toHaveText(
    "Sender Task → Target Task",
  );
  await expect(card.getByTestId("approval-text")).toHaveValue(
    "please rebase onto main",
  );

  await card.getByTestId("approval-text").fill("please rebase onto develop");
  await card.getByTestId("approval-approve").click();

  // The badge (and the sheet, with nothing left to review) go away.
  await expect(window.getByTestId("board-approval-inbox-button")).toHaveCount(
    0,
  );
  await expect(window.getByTestId("approval-inbox")).toHaveCount(0);
  await expect(
    window
      .getByTestId(`card-${targetId}`)
      .getByTestId("badge-approval-waiting"),
  ).toHaveCount(0);

  // Core now holds the edited message as deliverable (the fake pi never claims it).
  const message = (await external.commands.listMessages()).find(
    (item) => item.id === sent.message.id,
  );
  expect(message?.status).toBe("pending");
  expect(message?.text).toBe("please rebase onto develop");
  expect(message?.originalText).toBe("please rebase onto main");

  // The target has no live session: the background launcher wakes it.
  await expect
    .poll(() => {
      try {
        return readFileSync(invokeLogPath, "utf8").trim().length > 0;
      } catch {
        return false;
      }
    })
    .toBe(true);
});
