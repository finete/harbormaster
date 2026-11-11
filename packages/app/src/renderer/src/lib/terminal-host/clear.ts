/**
 * Cmd+K / context-menu "Clear" for a terminal pane.
 *
 * Only the normal buffer is cleared. A fullscreen program on the alternate
 * screen (pi, vim, less) owns every cell and repaints only the rows it
 * believes changed: wiping xterm's alt buffer behind its back blanks the
 * pane (all but the cursor row) with nothing to bring the content back
 * until the program happens to redraw, and a tab close then handed that
 * blank screen to the warm session. So clearing there is a no-op.
 */
export function clearTerminal(terminal: {
  buffer: { active: { type: string } };
  clear(): void;
}): boolean {
  if (terminal.buffer.active.type === "alternate") return false;
  terminal.clear();
  return true;
}
