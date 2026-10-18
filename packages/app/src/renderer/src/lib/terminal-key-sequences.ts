/**
 * CSI-u translation for the embedded (xterm.js) terminal panes.
 *
 * xterm.js cannot speak the Kitty keyboard protocol, so modified-Enter
 * combos collapse to plain `\r`/`\n` (or, for Option+Enter on macOS with
 * `macOptionIsMeta: true`, `ESC \r`) by the time they reach the pty — pi's
 * terminal-setup doc documents this exact gap for embedded/xterm-class
 * terminals (VS Code, Zed) and its workaround: send the modified key as an
 * explicit CSI-u sequence instead, `ESC [ <keycode> ; <modifier> u`, so pi
 * can tell `Shift+Enter` apart from plain `Enter` on the other end of the
 * pty. See pi's `docs/terminal-setup.md` ("VS Code integrated terminal",
 * "Zed integrated terminal") for the exact byte sequences this mirrors.
 *
 * This module only decides *which* sequence (if any) a given key event
 * maps to — it has no DOM/xterm dependency, so it's plain-unit-testable.
 * Wiring it into a live key event (write + suppress xterm's own handling)
 * lives in TerminalPane.tsx's `attachCustomKeyEventHandler`.
 */

/** The subset of `KeyboardEvent` this module reads — never the whole DOM event, so it's testable without jsdom. */
export interface TerminalKeyEventInput {
  type: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** IME composition in progress (e.g. CJK input); such keydowns must pass through untouched. */
  isComposing: boolean;
}

const CSI_U_KEYCODE_ENTER = 13;
const CSI_U_KEYCODE_MINUS = 45;

// CSI-u modifier parameter: 1 + (shift=1 | alt=2 | ctrl=4 | meta=8).
const CSI_U_MOD_SHIFT = 2;
const CSI_U_MOD_ALT = 3;
const CSI_U_MOD_CTRL = 5;

function csiU(keycode: number, modifier: number): string {
  return `\u001b[${keycode};${modifier}u`;
}

/**
 * Returns the CSI-u sequence pi expects for the handful of extended combos
 * an embedded xterm.js terminal would otherwise collapse, or `null` if
 * `event` is not one of those combos (including every ordinary keystroke,
 * which must flow through xterm's normal pipeline untouched).
 *
 * Mapped combos (pi's documented embedded-terminal set):
 * - Shift+Enter  -> `ESC [13;2u` (VS Code / Zed parity)
 * - Alt+Enter    -> `ESC [13;3u` (replaces xterm's `macOptionIsMeta` `ESC \r`)
 * - Ctrl+Enter   -> `ESC [13;5u`
 * - Ctrl+Minus   -> `ESC [45;5u` (Zed parity)
 */
export function csiUSequenceForKeyEvent(
  event: TerminalKeyEventInput,
): string | null {
  if (event.type !== "keydown") return null;
  if (event.isComposing) return null;
  // Meta held alongside these combos (e.g. Cmd+Shift+Enter) is out of
  // scope — don't guess, let xterm's default handling take it.
  if (event.metaKey) return null;

  if (event.key === "Enter") {
    if (event.shiftKey && !event.altKey && !event.ctrlKey) {
      return csiU(CSI_U_KEYCODE_ENTER, CSI_U_MOD_SHIFT);
    }
    if (event.altKey && !event.shiftKey && !event.ctrlKey) {
      return csiU(CSI_U_KEYCODE_ENTER, CSI_U_MOD_ALT);
    }
    if (event.ctrlKey && !event.shiftKey && !event.altKey) {
      return csiU(CSI_U_KEYCODE_ENTER, CSI_U_MOD_CTRL);
    }
    return null;
  }

  if (event.key === "-" && event.ctrlKey && !event.shiftKey && !event.altKey) {
    return csiU(CSI_U_KEYCODE_MINUS, CSI_U_MOD_CTRL);
  }

  return null;
}
