/**
 * Host-side wheel translation for xterm.js in mouse-tracking mode.
 *
 * xterm.js 6 sends at most one mouse report per WheelEvent regardless of how
 * many lines the gesture covered. Ghostty and kitty instead accumulate pixel
 * deltas and emit one report per cell-height of travel. This module replicates
 * that behaviour via `attachCustomWheelEventHandler`.
 *
 * References:
 * - Ghostty  src/Surface.zig:3564-3720
 * - kitty    kitty/mouse.c:1498-1560, 1778-1790
 * - xterm.js issue #6181 / PR #6182
 */

import type { HostContext, IDisposable } from "./context";

/** Unit-testable accumulator – no DOM dependency. */
export interface WheelAccumulator {
  /** Consume one WheelEvent's worth of delta. Returns the integer number of lines to report (signed). */
  consume(input: {
    deltaY: number;
    deltaMode: 0 | 1 | 2;
    cellHeightPx: number;
    rows: number;
  }): number;
  /** Reset fractional carry (call when re-using across sessions). */
  reset(): void;
}

/** Create a stateful wheel accumulator (Ghostty/kitty pixel-exact semantics). */
export function createWheelAccumulator(): WheelAccumulator {
  let carry = 0;

  return {
    consume({ deltaY, deltaMode, cellHeightPx, rows }) {
      // Convert to fractional lines.
      let lines: number;
      if (deltaMode === 1 /* DOM_DELTA_LINE */) {
        lines = deltaY;
      } else if (deltaMode === 2 /* DOM_DELTA_PAGE */) {
        lines = deltaY * rows;
      } else {
        // DOM_DELTA_PIXEL (0) — divide by cell height.
        // No 0.3 trackpad damping: one report per cell-height of travel is the
        // Ghostty/kitty semantic (xterm issue #6181).
        const h = cellHeightPx > 0 ? cellHeightPx : 15;
        lines = deltaY / h;
      }

      // Reset carry on direction change (kitty mouse.c:1527-1531 rationale).
      if (lines !== 0 && carry !== 0 && Math.sign(lines) !== Math.sign(carry)) {
        carry = 0;
      }

      carry += lines;
      const whole = Math.trunc(carry);
      carry -= whole;

      // Clamp to ±100 per event (safety cap).
      const clamped = Math.max(-100, Math.min(100, whole));
      return clamped;
    },

    reset() {
      carry = 0;
    },
  };
}

/**
 * Install the host-side wheel translation on a terminal.
 *
 * - When mouse tracking is ON (alt screen with ?1000h+ modes), or when the
 *   alt buffer is active without mouse tracking (less/man without mouse),
 *   we accumulate pixel deltas and dispatch N synthetic LINE-mode ±1 events.
 *   xterm's own handler turns each into one report or arrow key with full
 *   protocol support (SGR/X10/URXVT, coordinates, modifiers).
 *
 * - When the normal buffer is active and mouse tracking is OFF, we do NOT
 *   intercept: xterm scrolls its own viewport (plain scrollback). This
 *   preserves the standard no-mouse behaviour.
 *
 * - Synthetic events are tracked in a WeakSet so xterm can re-process them
 *   without re-entering our handler.
 */
export function installWheel(ctx: HostContext): IDisposable {
  const { terminal } = ctx;
  const acc = createWheelAccumulator();
  const synthetic = new WeakSet<WheelEvent>();

  /** Return the CSS pixel height of a single terminal cell. */
  function cellHeightPx(): number {
    const screen = terminal.element?.querySelector(".xterm-screen");
    if (!screen) return 15;
    const h = screen.getBoundingClientRect().height;
    const rows = terminal.rows;
    return rows > 0 && h > 0 ? h / rows : 15;
  }

  // Recompute cell height on resize (cached lazily via the function above).
  // No explicit cache needed: getBoundingClientRect() is cheap here (one call
  // per wheel event, not per frame).

  const handler = (ev: WheelEvent): boolean => {
    // Let xterm process synthetic events we dispatched.
    if (synthetic.has(ev)) return true;

    // Zero-delta: nothing to do.
    if (ev.deltaY === 0) return true;

    // Shift is reserved by xterm (text selection scroll).
    if (ev.shiftKey) return true;

    const isNormalBuffer = terminal.buffer.active.type === "normal";
    const mouseMode = terminal.modes.mouseTrackingMode;
    const hasMouseTracking = mouseMode !== "none";

    // Normal buffer with no mouse tracking: let xterm scroll its own viewport.
    if (isNormalBuffer && !hasMouseTracking) return true;

    // Alt buffer or mouse tracking active: we take over.
    const n = acc.consume({
      deltaY: ev.deltaY,
      deltaMode: ev.deltaMode as 0 | 1 | 2,
      cellHeightPx: cellHeightPx(),
      rows: terminal.rows,
    });

    ev.preventDefault();

    if (n === 0) return false;

    const target = ev.target;
    if (!(target instanceof EventTarget)) return false;

    const sign = Math.sign(n);
    for (let i = 0; i < Math.abs(n); i++) {
      const synth = new WheelEvent("wheel", {
        deltaY: sign,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: ev.clientX,
        clientY: ev.clientY,
        altKey: ev.altKey,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        bubbles: true,
        cancelable: true,
      });
      synthetic.add(synth);
      target.dispatchEvent(synth);
    }

    return false;
  };

  terminal.attachCustomWheelEventHandler(handler);

  return {
    dispose() {
      // Restore passthrough (same pattern as keys.ts).
      terminal.attachCustomWheelEventHandler(() => true);
      acc.reset();
    },
  };
}
