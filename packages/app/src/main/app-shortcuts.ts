/**
 * Pure helper that decides whether a `before-input-event` keyboard chord is an
 * app-level shortcut, scoped by platform (checklist item #9).
 *
 * On macOS every app shortcut requires Meta (Cmd), never Ctrl alone — Ctrl
 * belongs to the pty.  On other platforms Ctrl is the modifier (no Meta key).
 */

export interface InputEvent {
  /** Electron's before-input-event `input.type` ("keyDown" | "keyUp" | …). */
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * Returns true when `input` is the "close tab" shortcut for `platform`.
 *
 * - darwin: Cmd+W (meta only, not control)
 * - others: Ctrl+W
 */
export function isCloseTabChord(input: InputEvent, platform: string): boolean {
  if (input.type !== "keyDown") return false;
  if (input.alt || input.shift) return false;
  if (input.key.toLowerCase() !== "w") return false;
  if (platform === "darwin") {
    return input.meta && !input.control;
  }
  return input.control && !input.meta;
}

/**
 * Returns true when `input` is the "cycle sidebar" shortcut for `platform`.
 *
 * - darwin: Cmd+Shift+Up/Down (meta + shift, not control)
 * - others: Ctrl+Shift+Up/Down
 */
export function isSidebarCycleChord(
  input: InputEvent,
  platform: string,
): boolean {
  if (input.type !== "keyDown") return false;
  if (input.alt) return false;
  if (!input.shift) return false;
  if (input.key !== "ArrowUp" && input.key !== "ArrowDown") return false;
  if (platform === "darwin") {
    return input.meta && !input.control;
  }
  return input.control && !input.meta;
}
