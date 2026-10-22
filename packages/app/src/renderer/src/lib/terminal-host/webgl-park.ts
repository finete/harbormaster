/**
 * WebGL parking for hidden terminal panes.
 *
 * Every pane holding a live WebGL context costs GPU memory (drawing buffers
 * at its last visible size plus its own glyph-atlas textures) even while
 * hidden (an inactive task workspace or a detached dockview tab). With many
 * panes Chromium also starts evicting the oldest contexts, which then churn
 * (lose → DOM → re-acquire → evict another) on every task switch.
 *
 * The parker tracks a pane's visibility; once it has stayed hidden for
 * `delayMs()` it calls `park()` (the pane disposes its WebGL addon and frees
 * the context). Showing the pane again cancels a pending park, or calls
 * `unpark()` if it already parked. A short flicker (hide/show within the
 * delay) never touches the GPU.
 *
 * Pure: timers are injectable so unit tests can drive it with fake timers.
 */

/** Default time a pane must stay hidden before its WebGL context is parked. */
export const WEBGL_PARK_DELAY_MS = 10_000;

/**
 * Test knob: e2e sets `window.__harbormasterWebglParkDelayMs` to shorten the
 * park delay (read every time a hide starts, so it can be set at runtime).
 */
export function webglParkDelayMs(): number {
  const override = (globalThis as { __harbormasterWebglParkDelayMs?: unknown })
    .__harbormasterWebglParkDelayMs;
  return typeof override === "number" && override >= 0
    ? override
    : WEBGL_PARK_DELAY_MS;
}

export interface WebglParkerOptions {
  park: () => void;
  unpark: () => void;
  delayMs?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface WebglParker {
  /** Report the pane's current visibility; idempotent for repeated values. */
  setVisible(visible: boolean): void;
  isParked(): boolean;
  /** Cancel any pending park; does not unpark. */
  dispose(): void;
}

export function createWebglParker(options: WebglParkerOptions): WebglParker {
  const delayMs = options.delayMs ?? webglParkDelayMs;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown;
  let parked = false;
  let disposed = false;

  function cancel(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  return {
    setVisible(visible) {
      if (disposed) return;
      if (visible) {
        cancel();
        if (parked) {
          parked = false;
          options.unpark();
        }
        return;
      }
      if (parked || timer !== undefined) return;
      timer = setTimer(() => {
        timer = undefined;
        if (disposed) return;
        parked = true;
        options.park();
      }, delayMs());
    },
    isParked: () => parked,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

/**
 * Whether a pane's container is laid out with a real size. A detached or
 * `display:none` container would make FitAddon propose a garbage 11×6 size
 * (it parses the computed "100%" width/height as 100px), which reflows the
 * scrollback and SIGWINCHes the pty.
 */
export function isContainerVisible(el: {
  isConnected: boolean;
  clientWidth: number;
  clientHeight: number;
}): boolean {
  return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
}

/**
 * Free a WebGL addon's context immediately instead of waiting for GC (a
 * disposed-but-uncollected context still counts toward Chromium's
 * active-context limit). Reads the addon's internal `_renderer._gl`; must
 * be captured BEFORE `dispose()` (which drops the renderer) and lost AFTER
 * it, so the addon's own `webglcontextlost` listener is already gone.
 */
export function captureWebglContext(
  addon: unknown,
): { loseContext(): void } | undefined {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: internal addon field
    const gl = (addon as any)?._renderer?._gl as
      | WebGL2RenderingContext
      | undefined;
    if (!gl || typeof gl.getExtension !== "function") return undefined;
    return {
      loseContext() {
        try {
          if (gl.isContextLost()) return;
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        } catch {}
      },
    };
  } catch {
    return undefined;
  }
}
