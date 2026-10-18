// Performance harness: a fake `pi` that floods its pty with ANSI-colored
// output (a `yes`/`seq`-style unbounded stream, plus pi-like OSC title
// updates and periodic same-content state-file rewrites, like the extension
// re-saving bindings mid-turn) while this spec measures how responsive the
// renderer stays. Symptom it guards: "while an agent streams output the
// whole UI goes molasses — hovering a tab takes 500ms+ to highlight".
//
// Everything measured here is test-side instrumentation (main-process
// `webContents.send` counters via `electronApp.evaluate`, a renderer
// long-task / event-loop-lag probe via `page.evaluate`, and input-to-frame
// latency timed from the Playwright side) — no probe code ships in the app.
//
// The numbers are printed as one `[perf]` JSON line per phase (idle, flood)
// so a sweep can diff baseline vs after. The assertions are deliberately
// generous budgets (an order of magnitude above the post-fix numbers) so
// they flag a regression back to the per-chunk-IPC behavior without being
// flaky on a loaded CI box.
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
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { dragTo } from "./board-gestures";

const mainEntry = path.join(__dirname, "..", "out", "main", "index.js");

/** How long each measured phase (idle, flood) samples for. */
const PHASE_MS = 8_000;

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

function seedFixtureRepo(codeRoot: string): void {
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
    ["remote", "add", "origin", "https://github.com/test/fixture.git"],
    repoCheckout,
  );
}

/**
 * The fake pi: idles (printing one ready line) until `trigger` exists, then
 * floods forever. Each line carries SGR color codes like real agent output;
 * every 40th line also emits an OSC 0 title that changes (pi's spinner-ish
 * "working" title), and a background loop rewrites the state dir's
 * workspace-bindings.json with *identical* content twice a second (an
 * extension re-saving unchanged bindings mid-turn), which the app's state
 * watcher sees as a change.
 */
function floodScript(trigger: string): string {
  return `#!/bin/sh
echo "fake-pi ready"
while [ ! -f "${trigger}" ]; do sleep 0.1; done
(
  while true; do
    f="$HARBORMASTER_STATE_DIR/workspace-bindings.json"
    if [ -f "$f" ]; then cp "$f" "$f.perf-tmp" && mv "$f.perf-tmp" "$f"; fi
    sleep 0.5
  done
) &
exec awk 'BEGIN {
  for (i = 0; ; i++) {
    printf "\\033[32m%08d\\033[0m \\033[1;34magent\\033[0m streaming tool output \\033[33m%s\\033[0m lorem ipsum dolor sit amet\\n", i, i * 7919
    if (i % 40 == 0) printf "\\033]0;π - working %d\\007", int(i / 40) % 10
  }
}'
`;
}

interface RendererStats {
  longTasks: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  frames: number;
  frameGapP95Ms: number;
  frameGapMaxMs: number;
  lagSamples: number;
  lagP50Ms: number;
  lagP95Ms: number;
  lagMaxMs: number;
  localStorageWrites: number;
  visibility: string;
}

/** Installs the renderer probe (idempotent) and starts a fresh sampling window. */
async function startRendererProbe(window: Page): Promise<void> {
  await window.evaluate(() => {
    type Probe = {
      longTasks: number[];
      frameGaps: number[];
      lags: number[];
      localStorageWrites: number;
      stop: () => void;
    };
    const w = window as unknown as {
      __perfProbe?: Probe;
      __perfStoragePatched?: boolean;
    };
    w.__perfProbe?.stop();
    const probe: Probe = {
      longTasks: [],
      frameGaps: [],
      lags: [],
      localStorageWrites: 0,
      stop: () => {},
    };
    if (!w.__perfStoragePatched) {
      w.__perfStoragePatched = true;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        const current = (window as unknown as { __perfProbe?: Probe })
          .__perfProbe;
        if (current) current.localStorageWrites += 1;
        return original.call(this, key, value);
      };
    }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        probe.longTasks.push(entry.duration);
      }
    });
    observer.observe({ type: "longtask" });
    let running = true;
    let lastFrame = performance.now();
    const onFrame = (now: number): void => {
      if (!running) return;
      probe.frameGaps.push(now - lastFrame);
      lastFrame = now;
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
    const LAG_INTERVAL = 50;
    let expected = performance.now() + LAG_INTERVAL;
    const lagTimer = setInterval(() => {
      const now = performance.now();
      probe.lags.push(Math.max(0, now - expected));
      expected = now + LAG_INTERVAL;
    }, LAG_INTERVAL);
    probe.stop = () => {
      running = false;
      observer.disconnect();
      clearInterval(lagTimer);
    };
    w.__perfProbe = probe;
  });
}

async function stopRendererProbe(window: Page): Promise<RendererStats> {
  return window.evaluate(() => {
    const probe = (
      window as unknown as {
        __perfProbe: {
          longTasks: number[];
          frameGaps: number[];
          lags: number[];
          localStorageWrites: number;
          stop: () => void;
        };
      }
    ).__perfProbe;
    probe.stop();
    const pct = (values: number[], p: number): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[
        Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
      ] as number;
    };
    const round = (n: number): number => Math.round(n * 10) / 10;
    return {
      longTasks: probe.longTasks.length,
      longTaskTotalMs: round(probe.longTasks.reduce((a, b) => a + b, 0)),
      longTaskMaxMs: round(Math.max(0, ...probe.longTasks)),
      frames: probe.frameGaps.length,
      frameGapP95Ms: round(pct(probe.frameGaps, 95)),
      frameGapMaxMs: round(Math.max(0, ...probe.frameGaps)),
      lagSamples: probe.lags.length,
      lagP50Ms: round(pct(probe.lags, 50)),
      lagP95Ms: round(pct(probe.lags, 95)),
      lagMaxMs: round(Math.max(0, ...probe.lags)),
      localStorageWrites: probe.localStorageWrites,
      visibility: document.visibilityState,
    };
  });
}

/** Patches the window's `webContents.send` to count messages per channel (main process). */
async function startMainCounters(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as {
      __perfSendCounts?: Record<string, number>;
      __perfSendBytes?: number;
    };
    g.__perfSendCounts = {};
    g.__perfSendBytes = 0;
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents as unknown as {
        __perfPatched?: boolean;
        send: (channel: string, ...args: unknown[]) => void;
      };
      if (wc.__perfPatched) continue;
      wc.__perfPatched = true;
      const original = wc.send.bind(wc);
      wc.send = (channel: string, ...args: unknown[]) => {
        const counts = g.__perfSendCounts;
        if (counts) counts[channel] = (counts[channel] ?? 0) + 1;
        if (channel === "pty:data") {
          const payload = args[0] as { data?: string } | undefined;
          g.__perfSendBytes =
            (g.__perfSendBytes ?? 0) + (payload?.data?.length ?? 0);
        }
        original(channel, ...args);
      };
    }
  });
}

async function readMainCounters(
  app: ElectronApplication,
): Promise<{ counts: Record<string, number>; ptyChars: number }> {
  return app.evaluate(() => {
    const g = globalThis as unknown as {
      __perfSendCounts?: Record<string, number>;
      __perfSendBytes?: number;
    };
    return {
      counts: { ...(g.__perfSendCounts ?? {}) },
      ptyChars: g.__perfSendBytes ?? 0,
    };
  });
}

/**
 * Input-to-frame latency: a real (CDP-dispatched) mouse move onto a hover
 * target, then the next animation frame — the same path a CSS `:hover`
 * highlight has to wait through when the renderer main thread is busy.
 */
async function sampleHoverLatency(
  window: Page,
  targets: Locator[],
  durationMs: number,
): Promise<{ samples: number; p50Ms: number; p95Ms: number; maxMs: number }> {
  const points: { x: number; y: number }[] = [];
  for (const target of targets) {
    const box = await target.boundingBox();
    if (box)
      points.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  if (points.length === 0) throw new Error("no hover targets visible");
  const latencies: number[] = [];
  const deadline = Date.now() + durationMs;
  let i = 0;
  while (Date.now() < deadline) {
    const point = points[i % points.length] as { x: number; y: number };
    i += 1;
    const t0 = performance.now();
    await window.mouse.move(point.x, point.y);
    await window.evaluate(
      () =>
        new Promise<void>((resolve) => {
          // rAF can be throttled for an occluded/offscreen window; the
          // timeout keeps the sampler from hanging (and still measures the
          // main thread getting around to it).
          const timer = setTimeout(resolve, 100);
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
    );
    latencies.push(performance.now() - t0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (p: number): number =>
    Math.round(
      (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ??
        0) * 10,
    ) / 10;
  return {
    samples: latencies.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
  };
}

async function measurePhase(
  app: ElectronApplication,
  window: Page,
  hoverTargets: Locator[],
): Promise<Record<string, unknown>> {
  await startMainCounters(app);
  await startRendererProbe(window);
  const t0 = Date.now();
  const hover = await sampleHoverLatency(window, hoverTargets, PHASE_MS);
  const elapsedS = (Date.now() - t0) / 1000;
  const renderer = await stopRendererProbe(window);
  const main = await readMainCounters(app);
  const perSecond = (n: number | undefined): number =>
    Math.round(((n ?? 0) / elapsedS) * 10) / 10;
  return {
    elapsedS: Math.round(elapsedS * 10) / 10,
    hover,
    renderer,
    main: {
      ptyDataMsgsPerS: perSecond(main.counts["pty:data"]),
      ptyKCharsPerS: Math.round(main.ptyChars / elapsedS / 100) / 10,
      boardPushesPerS: perSecond(main.counts["core:board-changed"]),
      presencePushes: main.counts["core:presence-changed"] ?? 0,
      counts: main.counts,
    },
  };
}

test.describe("perf: UI stays responsive while a pi pane floods output", () => {
  let app: ElectronApplication;
  let window: Page;
  let root: string;
  let trigger: string;
  let xtermDiscardWarnings = 0;
  const mainProcessErrors: string[] = [];

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "harbormaster-e2e-perf-"));
    const stateDir = path.join(root, "state");
    const codeRoot = path.join(root, "Code");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(codeRoot, { recursive: true });
    seedFixtureRepo(codeRoot);
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({ automation: true, codeRoot, branchPrefix: "" }),
    );
    trigger = path.join(root, "flood-now");
    const fakePiPath = path.join(root, "fake-pi");
    writeFileSync(fakePiPath, floodScript(trigger));
    chmodSync(fakePiPath, 0o755);

    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        HARBORMASTER_STATE_DIR: stateDir,
        HARBORMASTER_USER_DATA_DIR: path.join(stateDir, "electron-profile"),
        HARBORMASTER_WINDOW_OFFSCREEN: "1",
        HARBORMASTER_PI_COMMAND: fakePiPath,
      },
    });
    watchForMainProcessErrors(app, mainProcessErrors);
    window = await app.firstWindow();
    window.on("console", (message) => {
      // xterm's own overflow warning: its write queue passed 50MB and it is
      // dropping output - the "no flow control" failure mode.
      if (/discarded/i.test(message.text())) xtermDiscardWarnings += 1;
    });
    await window.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    await app.close();
    expect(mainProcessErrors, mainProcessErrors.join("\n---\n")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("hover latency and long tasks stay bounded during a pty flood", async () => {
    test.setTimeout(120_000);
    const title = "Perf Flood Task";
    await window.getByTestId("sidebar-new-task-button").click();
    await window.getByTestId("new-task-title-input").fill(title);
    await window
      .getByTestId("new-task-repo-select")
      .selectOption("github.com/test/fixture");
    await window.getByTestId("new-task-destination-backlog").click();
    await window.getByTestId("new-task-submit").click();
    await expect(window.getByTestId("new-task-dialog")).toHaveCount(0);
    await window.getByTestId("board-button").click();
    const card = cardLocator(window, title);
    const cardTestId = await card.getAttribute("data-testid");
    if (!cardTestId) throw new Error("card missing data-testid");
    const taskId = cardTestId.replace("card-", "");
    await dragTo(window, card, window.getByTestId("column-dev"));
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              (id) => window.harbormaster.core.getTaskWorkspace(id),
              taskId,
            )
          )?.worktreePath,
        { timeout: 20_000 },
      )
      .toBeTruthy();
    await cardLocator(window, title).click();
    const panel = window.getByTestId("terminal-panel").first();
    await expect(panel).toContainText("fake-pi ready", { timeout: 20_000 });

    const hoverTargets = [
      window.getByTestId(`sidebar-task-row-${taskId}`),
      window.getByTestId("terminal-tab").first(),
      window.getByTestId("board-button"),
      window.getByTestId("add-terminal-button"),
    ];

    const idle = await measurePhase(app, window, hoverTargets);
    console.log(`[perf] idle ${JSON.stringify(idle)}`);

    writeFileSync(trigger, "go");
    // Let the flood reach steady state before sampling.
    await expect(window.getByTestId("terminal-tab").first()).toContainText(
      "working",
      { timeout: 20_000 },
    );
    await window.waitForTimeout(1_500);

    const flood = await measurePhase(app, window, hoverTargets);
    console.log(
      `[perf] flood ${JSON.stringify({ ...flood, xtermDiscardWarnings })}`,
    );

    // Regression budgets (see header): generous on purpose.
    const hover = flood.hover as { p50Ms: number; p95Ms: number };
    expect(hover.p95Ms).toBeLessThan(
      Number(process.env.HARBORMASTER_PERF_HOVER_P95_BUDGET_MS ?? 400),
    );
    const mainStats = flood.main as {
      ptyDataMsgsPerS: number;
      boardPushesPerS: number;
    };
    // Batched in main (~16ms / 64K-char flushes): baseline was ~45k
    // messages/s of tiny chunks; batched it is bounded by throughput / 64K.
    expect(mainStats.ptyDataMsgsPerS).toBeLessThan(
      Number(process.env.HARBORMASTER_PERF_PTY_MSGS_BUDGET ?? 2_000),
    );
    // Flow control keeps xterm's write queue bounded: it never overflows.
    expect(xtermDiscardWarnings).toBe(0);
    // Unchanged-content state rewrites must not reach the renderer.
    expect(mainStats.boardPushesPerS).toBeLessThan(1);
  });
});
