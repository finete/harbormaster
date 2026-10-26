/**
 * Coordinated WebGL renderer reset for every terminal pane.
 *
 * Why: on macOS, sleep, screen lock, or display sleep can discard a WebGL
 * canvas's backing store WITHOUT a `webglcontextlost` event, so the addon's
 * `onContextLoss` never fires and the pane draws blank until something forces
 * a full rebuild (xterm.js / VS Code #69665; superset #5261). A screen lock
 * fires neither `visibilitychange` nor `focus`, so the trigger comes from
 * main (`powerMonitor` resume / unlock-screen).
 *
 * Why every pane at once: `@xterm/addon-webgl` 0.19 shares one glyph atlas
 * between all terminals with equal font/theme/DPR (`CharAtlasCache`). Calling
 * `clearTextureAtlas()` on one pane garbles its siblings (xterm.js #6014,
 * fixed only in 0.20 beta), and a reloaded pane re-acquires the cached,
 * possibly-corrupt atlas as long as any other pane still owns it. So the
 * reset drops WebGL from ALL panes first (the cache empties when the last
 * owner leaves), then restores them on the next frame, which builds a fresh
 * atlas and context.
 *
 * Pure: the frame scheduler is injectable so unit tests can drive it.
 */

export interface ResettablePane {
  /** Dispose this pane's WebGL addon (if any); keep the terminal alive. */
  drop(): void;
  /** Re-acquire WebGL if the pane had it, and repaint every row. */
  restore(): void;
}

export interface RendererResetRegistry {
  /** Register a pane; returns an idempotent unregister. */
  register(pane: ResettablePane): () => void;
  /** Drop every pane now, restore them all on the next frame. */
  resetAll(): void;
  size(): number;
}

export function createRendererResetRegistry(
  nextFrame: (fn: () => void) => void = (fn) => requestAnimationFrame(fn),
): RendererResetRegistry {
  const panes = new Set<ResettablePane>();
  let pending = false;

  function safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.warn("[terminal] renderer reset step failed", error);
    }
  }

  return {
    register(pane) {
      panes.add(pane);
      return () => {
        panes.delete(pane);
      };
    },
    resetAll() {
      // Coalesce bursts (resume + unlock-screen arrive back to back).
      if (pending) return;
      pending = true;
      const dropped = [...panes];
      for (const pane of dropped) safely(() => pane.drop());
      nextFrame(() => {
        pending = false;
        // Only panes still registered: one unmounted in between is gone.
        for (const pane of dropped) {
          if (panes.has(pane)) safely(() => pane.restore());
        }
      });
    },
    size: () => panes.size,
  };
}

/**
 * Whether a window focus should trigger a reset: display sleep without a
 * lock fires no power event, but the user returning to the app after a long
 * absence does focus the window. Short app switches never reset (it costs
 * an atlas rebuild per visible pane).
 */
export function shouldResetOnFocus(
  blurredAt: number | undefined,
  now: number,
  minAwayMs: number,
): boolean {
  return blurredAt !== undefined && now - blurredAt >= minAwayMs;
}

/** Minimum time the window must have been unfocused for a focus reset. */
export const FOCUS_RESET_MIN_AWAY_MS = 5 * 60 * 1000;
