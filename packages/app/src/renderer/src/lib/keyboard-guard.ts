// Shared "is this keydown safe to treat as a single-key/global shortcut"
// guard. Used by App.tsx (Cmd/Ctrl+N) and Board.tsx (the TUI-style board
// keymap) to make sure typing into any text field, or the xterm terminal,
// never gets hijacked by a one-letter shortcut — the terminal in particular
// must receive every keystroke verbatim when focused.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // xterm.js renders its hidden input as a <textarea class="xterm-helper-textarea">
  // inside a `.xterm` container; closest() also catches a focus target
  // anywhere inside the terminal surface itself.
  if (target.closest(".xterm")) return true;
  return false;
}
