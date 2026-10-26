/**
 * App-wide wiring for the coordinated renderer reset (renderer-reset.ts):
 * one registry, one IPC subscription, one window focus/blur pair, created
 * lazily on the first pane registration.
 *
 * Triggers:
 * - main's `terminal:renderer-reset` (powerMonitor resume / unlock-screen);
 * - window focus after being unfocused for FOCUS_RESET_MIN_AWAY_MS, which
 *   covers display sleep without a lock (no power event fires for that).
 */
import {
  createRendererResetRegistry,
  FOCUS_RESET_MIN_AWAY_MS,
  type RendererResetRegistry,
  type ResettablePane,
  shouldResetOnFocus,
} from "./renderer-reset";

let registry: RendererResetRegistry | undefined;

function getRegistry(): RendererResetRegistry {
  if (registry) return registry;
  const created = createRendererResetRegistry();
  registry = created;
  window.harbormaster.terminal.onRendererReset(() => created.resetAll());
  let blurredAt: number | undefined;
  window.addEventListener("blur", () => {
    blurredAt = Date.now();
  });
  window.addEventListener("focus", () => {
    const reset = shouldResetOnFocus(
      blurredAt,
      Date.now(),
      FOCUS_RESET_MIN_AWAY_MS,
    );
    blurredAt = undefined;
    if (reset) created.resetAll();
  });
  return created;
}

/** Register a terminal pane for coordinated resets; returns unregister. */
export function registerResettablePane(pane: ResettablePane): () => void {
  return getRegistry().register(pane);
}
