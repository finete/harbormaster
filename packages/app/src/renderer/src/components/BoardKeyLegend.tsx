import type { JSX } from "react";
import { Kbd } from "./ui/kbd";

const ENTRIES: Array<{ key: string; label: string }> = [
  { key: "\u21b5", label: "Open" },
  { key: "n", label: "New" },
  { key: "x", label: "Done" },
  { key: "r", label: "Review" },
  { key: "s", label: "Start" },
  { key: "g", label: "Refresh" },
  { key: "a", label: "Archived" },
  { key: "\u2190\u2191\u2193\u2192", label: "Navigate" },
  { key: "esc", label: "Workspace" },
];

/**
 * pi-home-style one-line key help strip (its board renders a two-column
 * block of the same shortcuts — see home-board.ts's `shortcutPairs` — this
 * is the same content, laid out in a single wrapping row for the board's
 * width instead). Purely informational: every key here is wired in
 * Board.tsx's keydown handler, nothing here dispatches anything itself.
 */
export function BoardKeyLegend(): JSX.Element {
  return (
    <div
      data-testid="board-key-legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground"
    >
      {ENTRIES.map((entry) => (
        <span key={entry.label} className="flex items-center gap-1">
          <Kbd>{entry.key}</Kbd>
          {entry.label}
        </span>
      ))}
    </div>
  );
}
