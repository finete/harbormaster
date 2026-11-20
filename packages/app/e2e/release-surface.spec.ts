// Release surface (release plan, "Build and distribution"): the "new version
// available" card fed by a stubbed GitHub "latest release" endpoint, and
// "Export diagnostics" from the app menu, after "Profile Main Process" saved
// a CPU profile (the bundle must carry it, plus the runtime files: ptys,
// agent `ps`, session files, the renderer's long frames and focus), then the
// card's Restart once a fake app bundle is swapped under the running app.
// One launch covers all three seams;
// semver comparison, redaction and the zip format are unit-tested
// (tests/update-check.test.ts, tests/diagnostics.test.ts).
//
// The stub serves HTTPS with a self-signed certificate and the app launches
// with Chromium's --ignore-certificate-errors: only a fetch through
// Chromium's network stack (main/system-fetch.ts, which trusts the macOS
// keychain like a browser) honors that switch. Node's fetch would reject
// the certificate, as it rejects a TLS-inspecting proxy's, and no card
// would ever show.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:https";
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
import { readTestClipboardText } from "./test-clipboard";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

let app: ElectronApplication;
let window: Page;
let stateDir: string;
let server: Server;
let releaseRequests = 0;
let savePath: string;
let bundleDir: string;
const mainProcessErrors: string[] = [];
let mainOutput = "";

function writeFakeBundle(dir: string, version: string): void {
  mkdirSync(path.join(dir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(path.join(dir, "Contents", "MacOS", "Harbormaster"), version);
  writeFileSync(
    path.join(dir, "Contents", "Info.plist"),
    `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
}

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
  bundleDir = path.join(stateDir, "Harbormaster.app");
  writeFakeBundle(bundleDir, "0.0.1");

  // Stub GitHub "latest release" endpoint (same JSON shape as the real API).
  const keyPath = path.join(stateDir, "tls-key.pem");
  const certPath = path.join(stateDir, "tls-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  server = createServer(tls, (_req, res) => {
    releaseRequests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v999.0.0", draft: false }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  app = await electron.launch({
    args: [mainEntry, "--ignore-certificate-errors"],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: userData,
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      HARBORMASTER_UPDATE_URL: `https://127.0.0.1:${port}/repos/finete/harbormaster/releases/latest`,
      HARBORMASTER_E2E_SAVE_PATH: savePath,
      HARBORMASTER_MANUAL_PROFILE_MS: "300",
      HARBORMASTER_BUNDLE_EXECUTABLE: path.join(
        bundleDir,
        "Contents",
        "MacOS",
        "Harbormaster",
      ),
    },
  });
  const child = app.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    mainOutput += text;
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

test("a newer GitHub release, fetched through Chromium's TLS stack, shows a closable upgrade card with a copy button", async () => {
  const banner = window.getByTestId("update-banner");
  await expect(banner).toBeVisible();
  // A floating card in the bottom-right corner, not a strip.
  const box = await banner.boundingBox();
  const viewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(box && box.x > viewport.width / 2).toBe(true);
  expect(box && box.y > viewport.height / 2).toBe(true);
  expect(releaseRequests).toBeGreaterThan(0);
  await expect(banner).toHaveAttribute("data-version", "999.0.0");
  await expect(banner).toContainText("Harbormaster v999.0.0 is available");
  await expect(window.getByTestId("update-banner-command")).toHaveText(
    "brew update && brew upgrade --cask harbormaster",
  );

  // Copy goes through main's clipboard (the private test one).
  await window.getByTestId("update-banner-copy").click();
  await expect(window.getByTestId("update-banner-copy")).toHaveText("Copied");
  expect(await readTestClipboardText(app)).toBe(
    "brew update && brew upgrade --cask harbormaster",
  );

  await window.getByTestId("update-banner-dismiss").click();
  await expect(banner).toHaveCount(0);
  // Dismissal sticks for this version across a reload.
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await expect(window.getByTestId("workspace-view")).toBeVisible();
  await expect(window.getByTestId("update-banner")).toHaveCount(0);
});

test("Export Diagnostics in the app menu writes logs, a redacted config, versions, and the profile and runtime evidence", async () => {
  // A manual profile of main first: it lands in <userData>/logs/profiles.
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("profile-main");
    if (!item) throw new Error("no Profile Main Process menu item");
    item.click();
  });
  const profilesDir = path.join(
    stateDir,
    "electron-profile",
    "logs",
    "profiles",
  );
  await expect
    .poll(() =>
      existsSync(profilesDir)
        ? readdirSync(profilesDir).filter((n) =>
            n.endsWith("-manual.cpuprofile"),
          ).length
        : 0,
    )
    .toBe(1);

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
      "doctor.json",
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

  // The real V8 profile of the real main process.
  const read = (name: string): string =>
    execFileSync("unzip", ["-p", savePath, name], { encoding: "utf8" });
  const profileName = names.find((n) =>
    /^profiles\/.*-manual\.cpuprofile$/.test(n),
  );
  expect(profileName).toBeDefined();
  const profile = JSON.parse(read(profileName ?? ""));
  expect(profile.nodes.length).toBeGreaterThan(0);
  expect(profile.samples.length).toBeGreaterThan(0);
  // Runtime evidence, from main and from the renderer (executeJavaScript).
  expect(JSON.parse(read("ptys.json")).counts).toEqual(
    expect.objectContaining({ live: expect.any(Number) }),
  );
  expect(JSON.parse(read("agents-ps.json"))).toEqual({ agents: [] });
  expect(JSON.parse(read("session-files.json"))).toEqual([]);
  const renderer = JSON.parse(read("renderer.json"));
  expect(renderer.focus.view).toBe("workspace");
  expect(renderer.longFrames).toEqual(
    expect.objectContaining({ supported: true, thresholdMs: 50 }),
  );
  expect(typeof renderer.screenReaderMode).toBe("boolean");
  // Geometry for "the terminal is cropped" reports: window, sidebar, and
  // every mounted terminal's size (none are open in this fixture).
  expect(renderer.windowContentSize).toHaveLength(2);
  expect(renderer.focus.sidebar).toEqual(expect.any(Object));
  expect(Array.isArray(renderer.focus.terminals)).toBe(true);
});

// Last: Restart quits the app.
test("an app replaced on disk while running turns the card into Restart, which quits", async () => {
  expect(
    await window.evaluate(() => window.harbormaster.app.getInstalledUpdate()),
  ).toBeNull();

  // What `brew upgrade` does: the old bundle moves out, a new one moves in.
  // The window never gains focus here: main's periodic check finds it.
  const staged = `${bundleDir}.new`;
  writeFakeBundle(staged, "999.0.0");
  renameSync(bundleDir, `${bundleDir}.old`);
  renameSync(staged, bundleDir);

  const card = window.getByTestId("restart-banner");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-version", "999.0.0");
  await expect(card).toContainText("Harbormaster v999.0.0 is installed");
  await expect(window.getByTestId("update-banner")).toHaveCount(0);

  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  await window.getByTestId("restart-banner-restart").click();
  await exited;
  expect(mainOutput).toContain("[main] app replaced on disk (running ");
  expect(mainOutput).toContain(
    "[main] restart requested (test instance: quit only)",
  );
});
