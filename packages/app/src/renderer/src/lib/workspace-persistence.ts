// Pure localStorage-shaped persistence helpers for restoring open task
// workspaces + their dockview tab/split layout across app restarts (see
// AGENTS.md's "Attachment safety" + App.tsx's openTask takeover guard for
// why restoring never goes through the presence check). Same
// `StorageLike`-threaded, window-free pattern as lib/sidebar-persistence.ts
// so this is unit-testable under plain vitest.
import type { SerializedDockview } from "dockview-react";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The set of task ids that had an open workspace (rail tab) last run. */
export const WORKSPACE_OPENED_TASK_IDS_KEY =
  "harbormaster.workspace.openedTaskIds";
/** The focused task id at last run (restored focus, not just restored rail). */
export const WORKSPACE_FOCUSED_TASK_ID_KEY =
  "harbormaster.workspace.focusedTaskId";
/**
 * Per-task dockview layouts, keyed by task id, as dockview's own
 * `DockviewApi.toJSON()` output. Verified on the installed dockview-core
 * version (1.x): `fromJSON` round-trips arbitrary panel `params` (our
 * `{cwd, taskId, primary}`) cleanly because it just replays them through the
 * same panel factory `addPanel` uses — no custom schema needed.
 */
export const WORKSPACE_LAYOUTS_KEY = "harbormaster.workspace.layouts";

/** Restores the opened task id set persisted by `storeOpenedTaskIds`. */
export function readOpenedTaskIds(storage: StorageLike): Set<string> {
  try {
    const raw = storage.getItem(WORKSPACE_OPENED_TASK_IDS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

/** Persists the full opened task id set (called on every open/close, not just shutdown — see App.tsx). */
export function storeOpenedTaskIds(
  storage: StorageLike,
  opened: ReadonlySet<string>,
): void {
  try {
    storage.setItem(WORKSPACE_OPENED_TASK_IDS_KEY, JSON.stringify([...opened]));
  } catch {
    // Storage unavailable/full: this session just won't persist it.
  }
}

/** Restores the focused task id persisted by `storeFocusedTaskId` ("" if never set). */
export function readFocusedTaskId(storage: StorageLike): string {
  try {
    return storage.getItem(WORKSPACE_FOCUSED_TASK_ID_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Persists the focused task id. */
export function storeFocusedTaskId(storage: StorageLike, taskId: string): void {
  try {
    storage.setItem(WORKSPACE_FOCUSED_TASK_ID_KEY, taskId);
  } catch {
    // Storage unavailable/full: this session just won't persist it.
  }
}

function readLayoutMap(
  storage: StorageLike,
): Record<string, SerializedDockview> {
  try {
    const raw = storage.getItem(WORKSPACE_LAYOUTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, SerializedDockview>;
  } catch {
    return {};
  }
}

function writeLayoutMap(
  storage: StorageLike,
  layouts: Record<string, SerializedDockview>,
): void {
  try {
    storage.setItem(WORKSPACE_LAYOUTS_KEY, JSON.stringify(layouts));
  } catch {
    // Storage unavailable/full: this session just won't persist it.
  }
}

/** Restores one task's saved dockview layout, or `undefined` if never saved. */
export function readWorkspaceLayout(
  storage: StorageLike,
  taskId: string,
): SerializedDockview | undefined {
  return readLayoutMap(storage)[taskId];
}

/**
 * Persists one task's dockview layout (called on every `onDidLayoutChange`,
 * not just shutdown — see App.tsx's live-persistence note: launchctl can
 * SIGKILL the app with no clean-exit hook to flush state from).
 */
export function storeWorkspaceLayout(
  storage: StorageLike,
  taskId: string,
  layout: SerializedDockview,
): void {
  const layouts = readLayoutMap(storage);
  layouts[taskId] = layout;
  writeLayoutMap(storage, layouts);
}

/** Drops a task's saved layout (called when its workspace is closed, so a stale layout never lingers for a future reopen). */
export function removeWorkspaceLayout(
  storage: StorageLike,
  taskId: string,
): void {
  const layouts = readLayoutMap(storage);
  if (!(taskId in layouts)) return;
  delete layouts[taskId];
  writeLayoutMap(storage, layouts);
}

/**
 * Returns a copy of `layout` with every primary pane's `cwd`/`taskId` param
 * replaced by the live current values. The primary pi pane must resume
 * through the normal `claimSessionLaunch` path in the task's *current*
 * worktree (which can differ from the saved one — e.g. a Done task reopened
 * into a new cycle's worktree since the layout was last saved); non-primary
 * shell panels keep their saved `cwd` and simply respawn there.
 */
export function withLivePrimaryCwd(
  layout: SerializedDockview,
  taskId: string,
  cwd: string | undefined,
): SerializedDockview {
  const panels: SerializedDockview["panels"] = {};
  for (const [id, panel] of Object.entries(layout.panels)) {
    const params = panel.params as
      | { cwd?: string; taskId?: string; primary?: boolean }
      | undefined;
    if (params?.primary) {
      panels[id] = {
        ...panel,
        params: { ...params, cwd, taskId },
      };
      continue;
    }
    panels[id] = panel;
  }
  return { ...layout, panels };
}
