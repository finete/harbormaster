// Program Status Protocol (OSC 7501, revision 0.4) parser: a pure utility
// for whatever owns a program's pty (the app's main process today, a daemon
// later). See https://www.superlogical.com/rex/docs/build/program-status and
// docs/release-plan.md "Status: OSC 7501".
//
// The pty owner feeds every output chunk through `ProgramStatusParser.feed`:
// - reports (`ESC ] 7501 ; key=value:key=value ST`) are removed from the
//   output and returned as `{ state, message? }` events (root record only:
//   a report addressed to a child `id` is consumed but not surfaced);
// - the feature-detection probe (`ESC ] 7501 ; ? ST`, BEL- or ST-terminated)
//   is removed from the output and answered through `replies`, which the
//   owner writes back into the pty (the program reads it as input);
// - everything else passes through untouched, in order.
// A sequence split across chunks is held back until its terminator arrives
// (bounded by the protocol's 4096-byte sequence limit), so a report never
// leaks half-parsed into the terminal. No I/O, no clock.

/** The states a program can report (revision 0.4). `clear` on the root record surfaces as `idle`. */
export type ProgramState = "idle" | "working" | "blocked" | "done" | "error";

export const PROGRAM_STATES: readonly ProgramState[] = [
  "idle",
  "working",
  "blocked",
  "done",
  "error",
];

/** One root-record report, decoded. */
export interface ProgramStatusReport {
  state: ProgramState;
  /** Decoded `msg` (single line, no control characters), when present. */
  message?: string;
  /** `blocked` only: `permission` / `question` / `auth`. */
  kind?: "permission" | "question" | "auth";
  /** The reporting program's `app` id, when present. */
  app?: string;
}

export interface ProgramStatusFeedResult {
  /** The chunk with every complete OSC 7501 sequence removed. */
  output: string;
  /** Root-record reports, in stream order. */
  reports: ProgramStatusReport[];
  /** Bytes to write back to the program (probe answers), in order. */
  replies: string[];
}

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const INTRO = `${ESC}]7501;`;
/** Whole sequence cap from the spec (OSC through ST). */
const MAX_SEQUENCE_BYTES = 4096;
const MAX_MSG_ENCODED = 2732;
const KEY_PATTERN = /^[a-z]+$/;
const VALUE_PATTERN = /^[A-Za-z0-9_.,+/=-]*$/;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the spec forbids exactly these.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const ALL_STATES = new Set<string>([...PROGRAM_STATES, "clear"]);
const KINDS = new Set(["permission", "question", "auth"]);

/** The probe answer: supported, with the revision-0.4 default state/kind lists. */
export function programStatusProbeReply(terminator: string = ST): string {
  return `${INTRO}?${terminator}`;
}

function decodeText(value: string): string | undefined | null {
  if (value.length > MAX_MSG_ENCODED) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  let text: string;
  try {
    text = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
  if (text.includes("\uFFFD") || CONTROL_CHARS.test(text)) return null;
  return text;
}

/**
 * Parses one report body (the text between `7501;` and the terminator).
 * Returns `undefined` for a discarded or non-root report.
 */
export function parseProgramStatusBody(
  body: string,
): ProgramStatusReport | undefined {
  const pairs = new Map<string, string>();
  for (const raw of body.split(":")) {
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!KEY_PATTERN.test(key) || key.length > 16) continue;
    if (!VALUE_PATTERN.test(value)) continue;
    pairs.set(key, value);
  }
  const state = pairs.get("state");
  if (!state || !ALL_STATES.has(state)) return undefined;
  const id = pairs.get("id");
  if (id !== undefined && id !== "") {
    // Child records are valid but not ours to surface; malformed ids are ignored.
    return undefined;
  }
  let message: string | undefined;
  const msg = pairs.get("msg");
  if (msg !== undefined) {
    const decoded = decodeText(msg);
    if (decoded === null) return undefined;
    message = decoded || undefined;
  }
  const title = pairs.get("title");
  if (title !== undefined && decodeText(title) === null) return undefined;
  if (state === "clear") return { state: "idle" };
  const report: ProgramStatusReport = { state: state as ProgramState };
  if (message) report.message = message;
  const kind = pairs.get("kind");
  if (state === "blocked" && kind && KINDS.has(kind)) {
    report.kind = kind as NonNullable<ProgramStatusReport["kind"]>;
  }
  const app = pairs.get("app");
  if (app && APP_PATTERN.test(app)) report.app = app;
  return report;
}

/** Whether `text` ends with a proper prefix of the OSC 7501 introducer; returns that prefix's length. */
function partialIntroLength(text: string): number {
  const max = Math.min(INTRO.length - 1, text.length);
  for (let length = max; length > 0; length--) {
    if (text.endsWith(INTRO.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Stateful, per-pty OSC 7501 filter. Feed it every output chunk in order;
 * it holds back only a possibly-incomplete trailing 7501 sequence.
 */
export class ProgramStatusParser {
  private pending = "";

  feed(chunk: string): ProgramStatusFeedResult {
    const text = this.pending + chunk;
    this.pending = "";
    const reports: ProgramStatusReport[] = [];
    const replies: string[] = [];
    let output = "";
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(INTRO, cursor);
      if (start === -1) {
        const rest = text.slice(cursor);
        const hold = partialIntroLength(rest);
        output += rest.slice(0, rest.length - hold);
        this.pending = rest.slice(rest.length - hold);
        break;
      }
      output += text.slice(cursor, start);
      const bodyStart = start + INTRO.length;
      const end = this.findTerminator(text, bodyStart);
      if (end === "incomplete") {
        if (text.length - start > MAX_SEQUENCE_BYTES) {
          // Over the protocol's cap: not ours to hold; pass it through.
          output += text.slice(start, bodyStart);
          cursor = bodyStart;
          continue;
        }
        this.pending = text.slice(start);
        break;
      }
      if (end === "aborted") {
        output += text.slice(start, bodyStart);
        cursor = bodyStart;
        continue;
      }
      const body = text.slice(bodyStart, end.index);
      cursor = end.index + end.terminator.length;
      if (end.index + end.terminator.length - start > MAX_SEQUENCE_BYTES) {
        continue; // discarded whole, still consumed
      }
      if (body.trim() === "?") {
        replies.push(programStatusProbeReply(end.terminator));
        continue;
      }
      const report = parseProgramStatusBody(body);
      if (report) reports.push(report);
    }
    return { output, reports, replies };
  }

  /** Whether bytes are held back waiting for the rest of a sequence. */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Bytes held back waiting for a terminator (flushed as-is by `flush`). */
  flush(): string {
    const held = this.pending;
    this.pending = "";
    return held;
  }

  private findTerminator(
    text: string,
    from: number,
  ): { index: number; terminator: string } | "incomplete" | "aborted" {
    for (let index = from; index < text.length; index++) {
      const char = text[index];
      if (char === BEL) return { index, terminator: BEL };
      if (char === ESC) {
        if (index + 1 >= text.length) return "incomplete";
        if (text[index + 1] === "\\") return { index, terminator: ST };
        return "aborted";
      }
      if (char === "\x18" || char === "\x1a") return "aborted"; // CAN / SUB
    }
    return "incomplete";
  }
}
