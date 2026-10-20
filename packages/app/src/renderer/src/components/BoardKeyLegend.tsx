import type { JSX } from "react";
import { Kbd } from "./ui/kbd";

const ENTRIES: Array<{ key: string; label: string }> = [
  { key: "\u21b5", label: "Open" },
  { key: "n", label: "New" },
  { key: "s", label: "Start" },
  { key: "r", label: "Await (review)" },
  { key: "x", label: "Done" },
  { key: "g", label: "Refresh" },
  { key: "a", label: "Archived" },
  { key: "\u2190\u2191\u2193\u2192", label: "Navigate" },
  { key: "esc", label: "Workspace" },
];

/**
 * Small floating key-help card, pinned bottom-right of the board area (the
 * Board root is `relative`). It lays the same shortcuts as pi-home's
 * two-column block (see home-board.ts's `shortcutPairs`) out as a compact
 * 2-column grid. pointer-events-none so it never blocks card clicks or drags.
 * The workflow keys are the three verbs: s start, r await (opens the kind
 * picker with review preselected), x done. Purely informational: every key
 * here is wired in Board.tsx's keydown handler, nothing here dispatches.
 */
export function BoardKeyLegend(): JSX.Element {
  return (
    <div
      data-testid="board-key-legend"
      className="pointer-events-none absolute bottom-3 right-3 z-20 grid grid-cols-2 gap-x-3 gap-y-1 whitespace-nowrap rounded-md border border-border bg-card/90 px-2.5 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm"
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
