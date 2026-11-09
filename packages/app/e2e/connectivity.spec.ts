// Offline is an environmental state, not a wall of per-task error toasts
// (see engines/connectivity.ts, main/connectivity-loop.ts,
// renderer/ConnectivityBanner.tsx): a fake `gh` that fails with a
// network-shaped message must show one neutral banner and zero warning
// toasts, then clear itself the moment gh succeeds again.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { chooseWhere, submitAs } from "./composer";
import { ghGraphqlShimLine } from "./fake-gh";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd });
}

function watchForMainProcessErrors(
  electronApp: ElectronApplication,
  sink: string[],
): void {
  const child = electronApp.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) sink.push(text.trim());
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
}

function cardLocator(window: Page, title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

async function cardTaskId(card: Locator): Promise<string> {
  const testId = await card.getAttribute("data-testid");
  if (!testId) throw new Error("card missing data-testid");
  return testId.replace("card-", "");
}

function seedFixtureRepoWithBareRemote(root: string, codeRoot: string): void {
  const barePath = path.join(root, "bare-origin.git");
  git(["init", "-q", "--bare", "-b", "main", barePath]);

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
  git(["remote", "add", "origin", barePath], repoCheckout);
  git(["push", "-q", "origin", "main"], repoCheckout);
}

/**
 * A fake `gh` that fails with a connectivity-shaped error while a marker
 * file next to it exists, and answers an empty PR list once it is removed —
 * "swapping the fake gh" without relaunching the app, so a single run can
 * exercise both the offline and the recovery path.
 */
function writeFakeGhOfflineSwitchable(root: string): {
  ghPath: string;
  markerPath: string;
} {
  const ghPath = path.join(root, "fake-gh-offline");
  const markerPath = path.join(root, "offline-marker");
  writeFileSync(
    ghPath,
    [
      "#!/bin/sh",
      ghGraphqlShimLine(root),
      `marker="${markerPath}"`,
      'if [ -f "$marker" ]; then',
      '  echo "error connecting to api.github.com check your internet" >&2',
      "  exit 1",
      "fi",
      'case "$1 $2" in',
      '  "pr list")',
      "    printf '[]'",
      "    ;;",
      "  *)",
      "    printf '[]'",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(ghPath, 0o755);
  writeFileSync(markerPath, "offline\n");
  return { ghPath, markerPath };
}

test.describe("the connectivity banner replaces per-task warning toasts while gh is unreachable", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let markerPath: string;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-connectivity-"));
    const stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepoWithBareRemote(root, codeRoot);
    const { ghPath, markerPath: marker } = writeFakeGhOfflineSwitchable(root);
    markerPath = marker;
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        automation: true,
        codeRoot,
        branchPrefix: "",
      }),
    );

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
        HARBORMASTER_GH_COMMAND: ghPath,
      },
    });
    watchForMainProcessErrors(app, mainProcessErrors);
    window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    await app.close();
    expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a connectivity-shaped gh failure shows one offline banner and never a warning toast, then clears on recovery", async () => {
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill("Offline Task");
    await chooseWhere(window, { index: 1 });
    await submitAs(window, "park");
    await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

    await window.getByTestId("board-button").click();
    const card = cardLocator(window, "Offline Task");
    await expect(card).toBeVisible();
    const taskId = await cardTaskId(card);

    // refresh() only inspects dev/awaiting repo-backed tasks; move it out of
    // backlog so the next tick's PR status check actually calls (the
    // failing, connectivity-shaped) fake gh.
    await window.evaluate(
      (id) => window.harbormaster.core.startTask(id),
      taskId,
    );

    // Trigger a refresh deterministically instead of waiting out the app's
    // own cadence — same command surface the automation loop itself calls.
    await window.evaluate(() => window.harbormaster.core.refresh());

    const banner = window.getByTestId("connectivity-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute("data-state", "offline");
    await expect(banner).toContainText("Offline");

    // The whole point: never a per-task warning toast for this.
    await expect(window.getByTestId("toast-warning")).toHaveCount(0);
    await expect(window.getByTestId("toast-error")).toHaveCount(0);

    // "Swap the fake gh" by removing the marker, then trigger another
    // refresh: the next tick succeeds, so the banner clears itself.
    unlinkSync(markerPath);
    await window.evaluate(() => window.harbormaster.core.refresh());

    await expect(banner).toHaveAttribute("data-state", "restored", {
      timeout: 15_000,
    });
    await expect(banner).toContainText("restored");

    // "restored" auto-hides itself a few seconds later.
    await expect(window.getByTestId("connectivity-banner")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(window.getByTestId("toast-warning")).toHaveCount(0);
    await expect(window.getByTestId("toast-error")).toHaveCount(0);
  });
});
