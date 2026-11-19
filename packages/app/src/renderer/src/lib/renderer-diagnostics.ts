// The renderer's share of Export diagnostics and the `[health]` line.
//
// Long frames: a Long Animation Frames observer (Chromium's built-in 50 ms
// threshold) keeps the last `MAX_FRAMES` with the scripts that ran in them
// (file name and function only, never a full path), and once a minute
// reports how many there were and the worst to main, which adds it to the
// health line (`frames`). Today's lesson: "the renderer was idle, main was
// burning" should be readable at a glance.
//
// Focus: which view, task and dockview tab were showing, so a bug report
// says what the user was looking at when they exported.
//
// Main reads both at export time through `window.__harbormasterDiagnostics`
// (webContents.executeJavaScript; nothing here leaves the app otherwise).

export const MAX_FRAMES = 100;
const REPORT_INTERVAL_MS = 60_000;
const SCRIPTS_PER_FRAME = 3;

export interface LongFrameScript {
  invoker: string;
  source: string;
  fn: string;
  ms: number;
}

export interface LongFrame {
  at: string;
  ms: number;
  blockingMs: number;
  scripts: LongFrameScript[];
}

/** The slice of `PerformanceLongAnimationFrameTiming` read here. */
interface LoafEntryLike {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  scripts?: ReadonlyArray<{
    invoker?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
    duration?: number;
  }>;
}

/** Just the file name of a script URL (no path, no query). */
export function scriptFileName(url: string | undefined): string {
  if (!url) return "";
  const clean = url.split(/[?#]/)[0] ?? "";
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** One observed entry as kept in the ring (pure, for tests). */
export function toLongFrame(
  entry: LoafEntryLike,
  timeOrigin: number,
): LongFrame {
  const scripts = [...(entry.scripts ?? [])]
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, SCRIPTS_PER_FRAME)
    .map((script) => ({
      invoker: (script.invoker ?? "").slice(0, 120),
      source: scriptFileName(script.sourceURL),
      fn: (script.sourceFunctionName ?? "").slice(0, 120),
      ms: Math.round(script.duration ?? 0),
    }));
  return {
    at: new Date(timeOrigin + entry.startTime).toISOString(),
    ms: Math.round(entry.duration),
    blockingMs: Math.round(entry.blockingDuration ?? 0),
    scripts,
  };
}

export interface FrameRing {
  add(frame: LongFrame): void;
  frames(): LongFrame[];
  /** Count and worst since the last drain, then reset. */
  drain(): { long: number; maxMs: number };
}

export function createFrameRing(max: number = MAX_FRAMES): FrameRing {
  const ring: LongFrame[] = [];
  let long = 0;
  let maxMs = 0;
  return {
    add(frame) {
      ring.push(frame);
      if (ring.length > max) ring.shift();
      long += 1;
      maxMs = Math.max(maxMs, frame.ms);
    },
    frames: () => [...ring],
    drain() {
      const out = { long, maxMs };
      long = 0;
      maxMs = 0;
      return out;
    },
  };
}

// --- focus ------------------------------------------------------------------

export interface WorkspaceFocus {
  activePanel?: { id: string; title?: string; component?: string };
  panels: number;
}

let appFocus: { view: string; focusedTaskId: string } = {
  view: "",
  focusedTaskId: "",
};
const workspaces = new Map<string, () => WorkspaceFocus>();

/** App's current view and focused task (App.tsx keeps this current). */
export function setAppFocus(view: string, focusedTaskId: string): void {
  appFocus = { view, focusedTaskId };
}

/** A mounted TaskWorkspace describes its dockview; returns the unregister. */
export function registerWorkspaceFocus(
  taskId: string,
  read: () => WorkspaceFocus,
): () => void {
  workspaces.set(taskId, read);
  return () => {
    if (workspaces.get(taskId) === read) workspaces.delete(taskId);
  };
}

function focusSnapshot(): Record<string, unknown> {
  const read = workspaces.get(appFocus.focusedTaskId);
  let workspace: WorkspaceFocus | undefined;
  try {
    workspace = read?.();
  } catch {
    workspace = undefined;
  }
  return {
    view: appFocus.view,
    focusedTaskId: appFocus.focusedTaskId || null,
    openWorkspaces: workspaces.size,
    ...(workspace ? { workspace } : {}),
    windowFocused: document.hasFocus(),
    visibility: document.visibilityState,
  };
}

// --- wiring -----------------------------------------------------------------

declare global {
  interface Window {
    __harbormasterDiagnostics?: () => Record<string, unknown>;
  }
}

/** Starts the observer, the minutely report and the export hook; returns the stop. */
export function startRendererDiagnostics(): () => void {
  const ring = createFrameRing();
  const supported =
    typeof PerformanceObserver !== "undefined" &&
    (PerformanceObserver.supportedEntryTypes ?? []).includes(
      "long-animation-frame",
    );
  let observer: PerformanceObserver | undefined;
  if (supported) {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        ring.add(
          toLongFrame(
            entry as unknown as LoafEntryLike,
            performance.timeOrigin,
          ),
        );
      }
    });
    observer.observe({ type: "long-animation-frame", buffered: true });
  }
  const timer = setInterval(() => {
    const stats = ring.drain();
    if (stats.long > 0) window.harbormaster.app.reportFrameStats(stats);
  }, REPORT_INTERVAL_MS);
  window.__harbormasterDiagnostics = () => ({
    longFrames: { supported, thresholdMs: 50, frames: ring.frames() },
    focus: focusSnapshot(),
  });
  return () => {
    observer?.disconnect();
    clearInterval(timer);
    delete window.__harbormasterDiagnostics;
  };
}
