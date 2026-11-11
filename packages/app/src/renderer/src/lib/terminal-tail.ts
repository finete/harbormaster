// Mounted task primary panes by task id, so the inbox detail pane can read
// a task's last lines from its live pane (TerminalPane registers itself);
// main's headless mirror answers for paneless tasks (`core:terminalTail`).
import {
  bufferTail,
  INBOX_TAIL_LINES,
  type TailBuffer,
} from "../../../shared/terminal-tail";

const mounted = new Map<string, () => TailBuffer>();

export function registerTaskTerminal(
  taskId: string,
  buffer: () => TailBuffer,
): () => void {
  mounted.set(taskId, buffer);
  return () => {
    if (mounted.get(taskId) === buffer) mounted.delete(taskId);
  };
}

/** The mounted pane's tail for a task, or `undefined` when no pane shows it. */
export function mountedTaskTail(
  taskId: string,
  count = INBOX_TAIL_LINES,
): string | undefined {
  const buffer = mounted.get(taskId);
  return buffer ? bufferTail(buffer(), count) : undefined;
}
