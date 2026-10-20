// Tracks the DEC private modes (DECSET/DECRST, `CSI ? Pm h|l`) a program has
// set on its pty, from the raw output stream, so they can be replayed into a
// terminal that missed the program's startup.
//
// Why this exists: `@xterm/addon-serialize` snapshots the screen plus a few
// modes, but omits the mouse ENCODING (1005/1006/1015/1016) and cursor
// visibility (?25) — an attached renderer xterm would then send X10-encoded
// mouse reports that fullscreen pi (SGR-only) can't parse, and show a stray
// cursor. And a mirror created mid-stream (`detachPrimarySession`) never saw
// the startup sequences at all. This tracker runs from spawn, independent of
// whether anything is attached.

/** Max bytes of an unterminated `ESC [ ? ...` held between chunks. A real DECSET is far shorter; longer means garbage. */
const MAX_CARRY = 64;

/** Modes whose default (reset) state is ON; everything else defaults off. */
const DEFAULT_ON = new Set([7, 25]);
const MOUSE_TRACKING = new Set([9, 1000, 1002, 1003]);
const MOUSE_ENCODING = new Set([1005, 1006, 1015, 1016]);
const ALT_SCREEN = new Set([47, 1047, 1049]);
const SIMPLE = new Set([1, 7, 25, 1004, 2004]);

const PREFIX = "\x1b[?";

export interface TerminalModeTracker {
  /** Consume the next raw pty output chunk. */
  feed(data: string): void;
  /** Sequence re-establishing exactly the tracked non-default state ("" if none). */
  replaySequence(): string;
}

export function createTerminalModeTracker(): TerminalModeTracker {
  const simple = new Map<number, boolean>();
  let mouseTracking = 0;
  let mouseEncoding = 0;
  let altScreen = 0;
  let carry = "";

  const apply = (mode: number, on: boolean): void => {
    if (MOUSE_TRACKING.has(mode)) {
      // xterm.js keeps one active protocol: any set replaces it, any reset clears it.
      mouseTracking = on ? mode : 0;
    } else if (MOUSE_ENCODING.has(mode)) {
      if (on) mouseEncoding = mode;
      else if (mouseEncoding === mode) mouseEncoding = 0;
    } else if (ALT_SCREEN.has(mode)) {
      altScreen = on ? mode : 0;
    } else if (SIMPLE.has(mode)) {
      simple.set(mode, on);
    }
    // anything else (e.g. 2026 synchronized output) is deliberately ignored
  };

  const scan = (text: string): void => {
    let from = 0;
    for (;;) {
      const start = text.indexOf(PREFIX, from);
      if (start === -1) {
        // Hold a possible partial prefix at the very end.
        carry = partialPrefixTail(text);
        return;
      }
      let i = start + PREFIX.length;
      while (i < text.length && /[0-9;]/.test(text[i] as string)) i++;
      if (i >= text.length) {
        const rest = text.slice(start);
        carry = rest.length <= MAX_CARRY ? rest : "";
        return;
      }
      const final = text[i];
      if (final === "h" || final === "l") {
        for (const part of text.slice(start + PREFIX.length, i).split(";")) {
          if (part !== "") apply(Number(part), final === "h");
        }
      }
      from = i + 1;
    }
  };

  return {
    feed(data) {
      if (carry === "" && !data.includes("\x1b[?") && !endsWithPartial(data)) {
        return; // fast path: nothing relevant, nothing pending
      }
      const text = carry + data;
      carry = "";
      scan(text);
    },
    replaySequence() {
      let out = "";
      const emit = (mode: number, on: boolean): void => {
        out += `${PREFIX}${mode}${on ? "h" : "l"}`;
      };
      if (altScreen) emit(altScreen, true);
      for (const [mode, on] of simple) {
        if (on !== DEFAULT_ON.has(mode)) emit(mode, on);
      }
      if (mouseTracking) emit(mouseTracking, true);
      if (mouseEncoding) emit(mouseEncoding, true);
      return out;
    },
  };
}

function partialPrefixTail(text: string): string {
  for (let n = Math.min(PREFIX.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(PREFIX.slice(0, n))) return text.slice(text.length - n);
  }
  return "";
}

function endsWithPartial(text: string): boolean {
  return partialPrefixTail(text) !== "";
}
