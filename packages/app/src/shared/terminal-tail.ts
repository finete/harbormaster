// The last lines of a terminal's screen as plain text, for the inbox detail
// pane's static "last ~30 lines" (docs/release-plan.md "Inbox": no live
// terminal mirror in v1). Works on both xterm (a mounted pane, renderer)
// and @xterm/headless (a paneless background session, main): both expose
// the same buffer API. Pure; shared by main and the renderer.

/** The slice of xterm's buffer API both @xterm/xterm and @xterm/headless share. */
export interface TailBuffer {
  readonly length: number;
  getLine(
    index: number,
  ): { translateToString(trimRight?: boolean): string } | undefined;
}

export const INBOX_TAIL_LINES = 30;

/** The last `count` lines that have content, trailing blank rows dropped. */
export function bufferTail(buffer: TailBuffer, count: number): string {
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}
