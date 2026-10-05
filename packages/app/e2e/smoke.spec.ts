// Skeleton smoke lane — proves the electron-vite build boots, the mock board
// renders, and the dockview/xterm/node-pty wiring is alive end-to-end. Not a
// full test suite; see TASK notes in AGENTS.md / docs/design-decisions.md for
// what's in/out of scope for this skeleton.
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

// Main-process `uncaughtException` is logged (not dialog-boxed, see
// src/main/index.ts) as `[main] uncaughtException: ...` on stderr. Any such
// line during the run is a bug — a destroyed-window/pty race, a thrown IPC
// handler, etc — and must fail the suite, not just the app's UI.
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

test.beforeAll(async () => {
  app = await electron.launch({ args: [mainEntry] });
  watchForMainProcessErrors(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterEach(() => {
  assertNoMainProcessErrors();
});

test.afterAll(async () => {
  // electronApp.close() quits the app, which drives app 'before-quit' ->
  // disposeAllSessions() in main/index.ts. If that teardown path ever
  // throws (destroyed-window race, double-dispose, etc) it will have
  // surfaced as a `[main] uncaughtException` line, which the assertion
  // below catches — a clean close() must not leave orphan ptys or trigger
  // the crash dialog this suite is here to guard against.
  await app.close();
  assertNoMainProcessErrors();
});

test("app launches and the main window opens", async () => {
  expect(app.windows().length).toBeGreaterThan(0);
  await expect(window).toHaveTitle("Harbormaster");
});

test("kanban board renders all four columns with a running badge", async () => {
  for (const id of ["backlog", "dev", "awaiting", "done"]) {
    await expect(window.getByTestId(`column-${id}`)).toBeVisible();
  }
  // at least one card is visible, and the running card shows its spinner badge
  await expect(window.locator('[data-testid^="card-"]').first()).toBeVisible();
  await expect(window.getByTestId("badge-running").first()).toBeVisible();
});

test("a terminal panel appears and receives output from the pty", async () => {
  const panel = window.getByTestId("terminal-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-received-output", "true", {
    timeout: 20_000,
  });
});

test('"+ terminal" adds a second dockview terminal panel', async () => {
  const before = await window.getByTestId("terminal-panel").count();
  await window.getByTestId("add-terminal-button").click();
  await expect
    .poll(async () => window.getByTestId("terminal-panel").count(), {
      timeout: 10_000,
    })
    .toBeGreaterThan(before);
});
