// Pty fallback for Plannotator (docs/plannotator.md "Transport"): when a
// task's session was launched without the open-url handler in its env,
// Plannotator opens the system browser instead of telling the app. Every
// session prints `Plannotator session ready: <url>` on stderr first, so
// the pane owner watches the task's stream for it and opens the URL in the
// task's workspace itself.

const READY_PREFIX = "Plannotator session ready: ";
/** Kept across chunks so a line split between two pty reads still matches. */
const MAX_CARRY = 512;
// CSI / OSC / other two-byte escapes, so a coloured line still matches.
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point.
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const READY_LINE = /Plannotator session ready: (https?:\/\/\S+)/;

/**
 * Feeds raw pty output; returns each ready-line URL once, as soon as the
 * line containing it is complete (a newline follows the URL).
 */
export function createReadyLineMatcher(): (chunk: string) => string[] {
  let carry = "";
  return (chunk) => {
    const text = carry + chunk.replace(ANSI, "");
    const lines = text.split(/\r?\n|\r/);
    carry = (lines.pop() ?? "").slice(-MAX_CARRY);
    const urls: string[] = [];
    for (const line of lines) {
      if (!line.includes(READY_PREFIX)) continue;
      const match = READY_LINE.exec(line);
      if (match?.[1]) urls.push(match[1]);
    }
    return urls;
  };
}

/** The launch env var that means the session already reports URLs itself. */
export const OPEN_URL_HANDLER_ENV = "PLANNOTATOR_BROWSER";
