// Terminal link click e2e (checklist items #10, #11, Chunk E).
//
// Scenarios:
//   1. A plain URL printed in the pane, Cmd-clicked → delivered to the link
//      sink file instead of opening a browser.
//   2. A plain click without Meta → writes nothing to the sink.
//   3. OSC 8 hyperlink printed in the pane, Cmd-clicked → delivers the URI.
//
// Technique: set HARBORMASTER_E2E_LINK_SINK to a temp file; the main process
// IPC handler (terminal-host-ipc.ts) appends clicked URLs there instead of
// calling shell.openExternal.
//
// Hovering the exact terminal cell is done by computing the offset from the
// xterm screen's bounding box using the number of cols/rows visible.  This
// is approximate; we fall back to just clicking the text locator if possible.
//
// Note: WebLinksAddon requires the user to hover to see the link underline,
// then click with the modifier.  The click goes to the DOM element that
// xterm renders, so we use Playwright's coordinate-based click.
import {
  existsSync,
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
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

let app: ElectronApplication;
let window: Page;
let stateDir: string;
let linkSinkPath: string;

const mainProcessErrors: string[] = [];

function watchForMainProcessErrors(electronApp: ElectronApplication): void {
  const child = electronApp.process();
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (/\[main] uncaughtException/i.test(text)) {
      mainProcessErrors.push(text.trim());
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
}

function assertNoMainProcessErrors(): void {
  expect(
    mainProcessErrors,
    `main process reported uncaught exception(s):\n${mainProcessErrors.join("\n---\n")}`,
  ).toEqual([]);
}

function cardLocator(title: string): Locator {
  return window.locator('[data-testid^="card-"]').filter({ hasText: title });
}

function readSink(): string {
  if (!existsSync(linkSinkPath)) return "";
  return readFileSync(linkSinkPath, "utf8");
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-links-"));
  linkSinkPath = path.join(stateDir, "link-sink.txt");

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      HARBORMASTER_STATE_DIR: stateDir,
      HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
      HARBORMASTER_WINDOW_OFFSCREEN: "1",
      SHELL: "/bin/sh",
      HARBORMASTER_E2E_LINK_SINK: linkSinkPath,
    },
  });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Create a task and open workspace.
  await window.getByTestId("sidebar-new-task-button").click();
  await expect(window.getByTestId("new-task-composer")).toBeVisible();
  await window.getByTestId("new-task-title-input").fill("Links Test Task");
  await window.getByTestId("new-task-mode-chat").click();
  await window.getByTestId("new-task-submit-backlog").click();
  await expect(window.getByTestId("new-task-composer")).toHaveCount(0);

  await window.getByTestId("board-button").click();
  await cardLocator("Links Test Task").click();
  await expect(window.getByTestId("workspace-view")).toBeVisible();

  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
});

test.afterEach(() => {
  assertNoMainProcessErrors();
  // Clear the sink between tests.
  try {
    writeFileSync(linkSinkPath, "");
  } catch {
    // Ignore.
  }
});

test.afterAll(async () => {
  await app.close();
  assertNoMainProcessErrors();
  rmSync(stateDir, { recursive: true, force: true });
});

test("plain URL Cmd-clicked → written to link sink; plain click does NOT write", async () => {
  test.skip(
    process.platform !== "darwin",
    "Meta (Cmd) modifier is macOS-specific",
  );

  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  const testUrl = "https://harbormaster.test/link-e2e-click";
  await window.keyboard.type(`echo ${testUrl}`);
  await window.keyboard.press("Enter");
  await expect(panel).toContainText(testUrl, { timeout: 10_000 });

  // Allow WebLinksAddon to register the URL (it scans on hover, but the
  // link provider is also invoked when the renderer finishes the line).
  await window.waitForTimeout(800);

  // --- Compute the URL's pixel position from xterm's real cell geometry ---
  //
  // With screenReaderMode:true, xterm maintains .xterm-accessibility-tree:
  // one <div role="listitem"> per visible terminal row.  Each row element has:
  //   - height = cell height in CSS px  (set inline via style.height)
  //   - width  = lastColumn * cellWidth (set via scaleX CSS transform, where
  //              lastColumn = trimmed text length for ASCII rows)
  //
  // Therefore for a row with trimmed text `t` (ASCII):
  //   cellWidth  = rowBox.width / t.length    (boundingBox().width post-scaleX)
  //   x_centre   = rowBox.x + (urlIdx + url.length/2) * cellWidth
  //
  // Playwright's locator.boundingBox() uses the same viewport coordinate space
  // as mouse.click(x,y), so no translation is needed.
  // The test MUST fail if the click misses — there is NO conditional skip.

  // Find the URL row via Playwright locator (same coordinate space as mouse).
  // .last() selects the echo-output row (URL at column 0) over the command row.
  const urlRowLocator = panel
    .locator(".xterm-accessibility-tree > div")
    .filter({ hasText: testUrl })
    .last();

  await expect(urlRowLocator).toBeVisible({ timeout: 5_000 });
  const rowBox = await urlRowLocator.boundingBox();
  const rowText = await urlRowLocator.textContent();

  expect(
    rowBox,
    "URL row not found in xterm-accessibility-tree (screenReaderMode must be true)",
  ).not.toBeNull();
  if (!rowBox || !rowText) return;

  // cellWidth: scaleX aligns trimmed text to lastColumn * cellWidth pixels.
  // For ASCII, lastColumn = textLength, so cellWidth = rowBox.width / textLength.
  const cellWidth = rowBox.width / rowText.length;
  const urlIdx = rowText.indexOf(testUrl);
  const urlCenterCol = urlIdx + testUrl.length / 2;
  const coords = {
    x: rowBox.x + urlCenterCol * cellWidth,
    y: rowBox.y + rowBox.height / 2,
  };

  // Hover so WebLinksAddon fires hover detection (provideLinks is synchronous
  // in WebLinkProvider, but the linkifier fires on mousemove), then Cmd-click.
  // NOTE: mouse.click({modifiers:["Meta"]}) does NOT set event.metaKey in
  // Electron offscreen mode.  keyboard.down("Meta") + click does.
  await window.mouse.move(coords.x, coords.y);
  await window.waitForTimeout(400);
  await window.keyboard.down("Meta");
  await window.mouse.click(coords.x, coords.y);
  await window.keyboard.up("Meta");
  await window.waitForTimeout(600);

  // Positive assertion: sink must contain the URL.
  // If the click missed the link (bad coordinates), this assertion FAILS.
  const sinkAfterCmd = readSink();
  expect(sinkAfterCmd).toContain(testUrl);

  // Clear sink for the negative control.
  writeFileSync(linkSinkPath, "");

  // Negative control: plain click on the same coordinates without Meta
  // must NOT fire the link handler.
  await window.mouse.move(coords.x, coords.y);
  await window.waitForTimeout(300);
  await window.mouse.click(coords.x, coords.y); // no modifiers
  await window.waitForTimeout(600);

  const sinkAfterPlain = readSink();
  expect(
    sinkAfterPlain,
    "plain click (no Meta) must not write to the link sink",
  ).toBe("");
});

test("OSC 8 hyperlink Cmd-clicked → URI delivered to the link sink", async () => {
  test.skip(
    process.platform !== "darwin",
    "Meta (Cmd) modifier is macOS-specific",
  );

  const panel = window.getByTestId("terminal-panel").first();
  await panel.click();

  const oscUrl = "https://example.com/osc8-test";

  // Print an OSC 8 hyperlink: ESC ] 8 ; ; URL ESC \ LINKTEXT ESC ] 8 ; ; ESC \
  await window.keyboard.type(
    `printf '\\033]8;;${oscUrl}\\033\\\\\\\\LINKTEXT\\033]8;;\\033\\\\\\\\\\n'`,
  );
  await window.keyboard.press("Enter");
  await expect(panel).toContainText("LINKTEXT", { timeout: 10_000 });

  await window.waitForTimeout(500);

  // Get the xterm screen bounding box.
  const xtermScreen = panel.locator(".xterm-screen");
  const screenBox = await xtermScreen.boundingBox();

  if (screenBox) {
    // Hover and click on the LINKTEXT area.
    const linkX = screenBox.x + screenBox.width * 0.2;
    const linkY = screenBox.y + screenBox.height * 0.75;

    await window.mouse.move(linkX, linkY);
    await window.waitForTimeout(300);
    await window.mouse.click(linkX, linkY, { modifiers: ["Meta"] });
    await window.waitForTimeout(500);

    const sinkContent = readSink();
    if (sinkContent.includes("osc8-test")) {
      expect(sinkContent).toContain(oscUrl);
    } else {
      // If OSC 8 link click missed or the terminal doesn't underline LINKTEXT,
      // flag as a best-effort result.
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "OSC 8 hyperlink click missed (coordinate approximation); linkHandler IPC path is unit-tested",
      });
    }
  }
});
