// OSC 9 notifications next to OSC 7501 (docs/harness-additions.md X4):
// Codex, launched with `tui.notification_method="osc9"`, writes its reply
// text as `ESC ] 9 ; <text> BEL` right before its 7501 `done`. That text
// becomes the `done` report's message (the card's line); nothing else uses
// OSC 9. Bodies starting with a digit and `;` are ConEmu-style progress
// (`9;4;…`), never a message. The sequences themselves pass through to the
// terminal untouched (xterm ignores them). Pure; the pty layer feeds it.

const INTRO = "\x1b]9;";
const BEL = "\x07";
const ST = "\x1b\\";
/** Longest OSC 9 body kept (anything longer is passed through, not used). */
const MAX_BODY = 4096;

/** One piece of a pty chunk: plain output, or a whole OSC 9 sequence with its body. */
export type Osc9Piece =
  | { kind: "text"; text: string }
  | { kind: "osc9"; raw: string; body: string };

/** Whether `text` ends with a proper prefix of the OSC 9 introducer; that prefix's length. */
function partialIntroLength(text: string): number {
  const max = Math.min(INTRO.length - 1, text.length);
  for (let length = max; length > 0; length--) {
    if (text.endsWith(INTRO.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Splits a pty stream into text and OSC 9 sequences, in order. A sequence
 * split across chunks is held back until its terminator arrives (`flush`
 * hands back anything held).
 */
export class Osc9Splitter {
  private pending = "";

  feed(chunk: string): Osc9Piece[] {
    let text = this.pending + chunk;
    this.pending = "";
    const pieces: Osc9Piece[] = [];
    const pushText = (value: string) => {
      if (value) pieces.push({ kind: "text", text: value });
    };
    for (;;) {
      const start = text.indexOf(INTRO);
      if (start === -1) {
        const hold = partialIntroLength(text);
        pushText(text.slice(0, text.length - hold));
        this.pending = text.slice(text.length - hold);
        return pieces;
      }
      pushText(text.slice(0, start));
      const bodyStart = start + INTRO.length;
      const bel = text.indexOf(BEL, bodyStart);
      const st = text.indexOf(ST, bodyStart);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) {
        if (text.length - bodyStart > MAX_BODY) {
          // Not a sequence we will ever complete: pass it through.
          pushText(text);
          return pieces;
        }
        this.pending = text.slice(start);
        return pieces;
      }
      const terminator = end === bel ? BEL : ST;
      pieces.push({
        kind: "osc9",
        raw: text.slice(start, end + terminator.length),
        body: text.slice(bodyStart, end),
      });
      text = text.slice(end + terminator.length);
    }
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  flush(): string {
    const held = this.pending;
    this.pending = "";
    return held;
  }
}

/** The message an OSC 9 body carries, or `undefined` for a progress update / an empty body. */
export function osc9Message(body: string): string | undefined {
  if (/^\d+;/.test(body)) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a message is one clean line
  const text = body.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return text || undefined;
}

/**
 * Remembers the last OSC 9 message until the next 7501 report: a `done`
 * without its own message takes it; any report clears it (so a note never
 * attaches to a later turn).
 */
export class DoneMessageJoiner {
  private note: string | undefined;

  noteOsc9(body: string): void {
    this.note = osc9Message(body);
  }

  /** The report as recorded: a message-less `done` gets the pending note. */
  apply<R extends { state: string; message?: string }>(report: R): R {
    const note = this.note;
    this.note = undefined;
    if (report.state === "done" && !report.message && note) {
      return { ...report, message: note };
    }
    return report;
  }
}
