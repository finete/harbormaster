// Orphaned worktrees (directories under <stateDir>/worktrees, or a legacy
// <codeRoot>/.harbormaster-worktrees, that no task owns) once filled the disk without a word. At startup the
// renderer asks core for an orphan scan and, past the threshold (10 dirs or
// 20 GB, decided in core), shows one sticky warning toast with a
// "Show in Finder" action. The action itself is not clicked: it would open a
// visible Finder window, and the user must never see a test run.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "playwright/test";

let app: ElectronApplication;
let window: Page;
let root: string;
let stateDir: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-orphans-"));
  stateDir = path.join(root, "state");
  const codeRoot = path.join(root, "Code");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ codeRoot, branchPrefix: "" }),
  );
  // Ten leaked test worktrees, owned by no binding: exactly the count
  // threshold, six in the worktrees root and four in a pre-0.1.2 legacy
  // folder (both are scanned and counted together).
  for (let i = 0; i < 10; i++) {
    const dir =
      i < 6
        ? path.join(stateDir, "worktrees", "some-repo", `observed-${i}`)
        : path.join(codeRoot, ".harbormaster-worktrees", `observed-${i}`);
    mkdirSync(dir, { recursive: true });
  }
  app = await electron.launch({
    args: [path.join(__dirname, "..", "out", "main", "index.js")],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(root, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
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

test("orphaned worktrees past the threshold surface one warning with a Show in Finder action", async () => {
  const toast = window
    .getByTestId("toast-warning")
    .filter({ hasText: "belong to no task" });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("10 worktrees");
  // Named after the root holding most of them.
  await expect(toast).toContainText(path.join(stateDir, "worktrees"));
  await expect(toast.getByTestId("toast-action")).toHaveText("Show in Finder");
});
