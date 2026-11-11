// Release surface (release plan, "Build and distribution"): the "new version
// available" banner fed by a stubbed GitHub "latest release" endpoint, and
// "Export diagnostics" from the app menu. One launch covers both seams;
// semver comparison, redaction and the zip format are unit-tested
// (tests/update-check.test.ts, tests/diagnostics.test.ts).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

let app: ElectronApplication;
let window: Page;
let stateDir: string;
let server: Server;
let releaseRequests = 0;
let savePath: string;
const mainProcessErrors: string[] = [];

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-release-"));
  const userData = path.join(stateDir, "electron-profile");
  mkdirSync(path.join(userData, "logs"), { recursive: true });
  writeFileSync(path.join(userData, "logs", "wake.log"), "power: resume\n");
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({
      automation: true,
      githubToken: "ghp_should_never_leave_the_machine",
      repositories: {
        "github.com/acme/app": {
          deployment: [
            { name: "prod", versionUrl: "https://bob:pw@prod.example/v" },
          ],
        },
      },
    }),
  );
  savePath = path.join(stateDir, "diagnostics.zip");

  // Stub GitHub "latest release" endpoint (same JSON shape as the real API).
  server = createServer((_req, res) => {
    releaseRequests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v999.0.0", draft: false }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: userData,
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_UPDATE_URL: `http://127.0.0.1:${port}/repos/finete/harbormaster/releases/latest`,
      HARBORMASTER_E2E_SAVE_PATH: savePath,
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) {
      mainProcessErrors.push(text.trim());
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  expect(mainProcessErrors).toEqual([]);
  rmSync(stateDir, { recursive: true, force: true });
});

test("a newer GitHub release shows a dismissible upgrade banner with a copy button", async () => {
  const banner = window.getByTestId("update-banner");
  await expect(banner).toBeVisible();
  expect(releaseRequests).toBeGreaterThan(0);
  await expect(banner).toHaveAttribute("data-version", "999.0.0");
  await expect(banner).toContainText("Harbormaster v999.0.0 is available");
  await expect(window.getByTestId("update-banner-command")).toHaveText(
    "brew upgrade --cask harbormaster",
  );

  // Copy goes through main's clipboard; keep the developer's clipboard.
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await window.getByTestId("update-banner-copy").click();
    await expect(window.getByTestId("update-banner-copy")).toHaveText("Copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "brew upgrade --cask harbormaster",
    );
  } finally {
    await app.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      previous,
    );
  }

  await window.getByTestId("update-banner-dismiss").click();
  await expect(banner).toHaveCount(0);
  // Dismissal sticks for this version across a reload.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("update-banner")).toHaveCount(0);
});

test("Export Diagnostics in the app menu writes logs, a redacted config and versions", async () => {
  await app.evaluate(({ Menu }) => {
    const item =
      Menu.getApplicationMenu()?.getMenuItemById("export-diagnostics");
    if (!item) throw new Error("no Export Diagnostics menu item");
    item.click();
  });
  await expect.poll(() => existsSync(savePath)).toBe(true);
  // The file is written in one writeFileSync; wait until it is a whole zip.
  await expect
    .poll(() => {
      try {
        execFileSync("unzip", ["-tq", savePath]);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);

  const names = execFileSync("unzip", ["-Z1", savePath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  expect(names).toEqual(
    expect.arrayContaining([
      "config.redacted.json",
      "logs/wake.log",
      "rules-list.txt",
      "versions.json",
    ]),
  );
  const config = execFileSync(
    "unzip",
    ["-p", savePath, "config.redacted.json"],
    {
      encoding: "utf8",
    },
  );
  expect(config).not.toContain("ghp_should_never_leave_the_machine");
  expect(config).not.toContain("bob:pw");
  expect(JSON.parse(config).githubToken).toBe("[redacted]");
  const versions = JSON.parse(
    execFileSync("unzip", ["-p", savePath, "versions.json"], {
      encoding: "utf8",
    }),
  );
  expect(versions.electron).toMatch(/^\d+\.\d+\.\d+/);
  expect(versions.node).toMatch(/^\d+\.\d+\.\d+/);
  expect(typeof versions.app).toBe("string");
});
