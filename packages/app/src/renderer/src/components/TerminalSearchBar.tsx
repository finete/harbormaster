/**
 * Floating search bar for terminal panes (checklist item #12).
 *
 * Absolutely positioned in the top-right of the terminal host.
 * Keyboard shortcuts: Enter/Cmd+G = findNext, Shift+Enter/Cmd+Shift+G = findPrevious, Esc closes.
 */

import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { SearchHandle } from "../lib/terminal-host/search";

export function TerminalSearchBar({
  search,
  onClose,
}: {
  search: SearchHandle;
  onClose: () => void;
}): JSX.Element {
  const [term, setTerm] = useState("");
  const [noResults, setNoResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function findNext(t: string) {
    if (!t) return;
    const found = search.findNext(t, { incremental: false });
    setNoResults(!found);
  }

  function findPrevious(t: string) {
    if (!t) return;
    const found = search.findPrevious(t, { incremental: false });
    setNoResults(!found);
  }

  function handleChange(value: string) {
    setTerm(value);
    setNoResults(false);
    if (value) {
      const found = search.findNext(value, { incremental: true });
      setNoResults(!found);
    } else {
      search.clearActiveDecoration();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey || (e.metaKey && e.shiftKey)) {
        findPrevious(term);
      } else {
        findNext(term);
      }
      return;
    }
    // Cmd+G / Cmd+Shift+G
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious(term);
      } else {
        findNext(term);
      }
    }
  }

  return (
    <div
      data-testid="terminal-search"
      className="absolute right-2 top-2 z-50 flex items-center gap-1 rounded border border-border bg-background px-2 py-1 shadow-lg"
    >
      <input
        ref={inputRef}
        data-testid="terminal-search-input"
        type="text"
        value={term}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search…"
        className="w-40 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      {noResults && term && (
        <span
          data-testid="terminal-search-empty"
          className="text-xs text-muted-foreground"
        >
          No results
        </span>
      )}
      <button
        type="button"
        onClick={() => findPrevious(term)}
        className="rounded px-1 text-xs text-foreground hover:bg-muted"
        aria-label="Previous result"
        title="Previous (Shift+Enter)"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => findNext(term)}
        className="rounded px-1 text-xs text-foreground hover:bg-muted"
        aria-label="Next result"
        title="Next (Enter)"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded px-1 text-xs text-foreground hover:bg-muted"
        aria-label="Close search"
      >
        ✕
      </button>
    </div>
  );
}
