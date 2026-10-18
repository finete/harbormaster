/**
 * Terminal search integration (checklist item #12).
 *
 * Loads @xterm/addon-search and wires Cmd+F to open the search bar.
 * The UI (TerminalSearchBar) is rendered by TerminalPane; this module
 * provides the addon handle and opens the bar via ctx.openSearch().
 */

import { SearchAddon } from "@xterm/addon-search";
import type { HostContext, IDisposable } from "./context";

export interface SearchHandle {
  findNext(term: string, opts?: { incremental?: boolean }): boolean;
  findPrevious(term: string, opts?: { incremental?: boolean }): boolean;
  clearActiveDecoration(): void;
  addon: SearchAddon;
}

export function installSearch(
  ctx: HostContext,
): IDisposable & { search: SearchHandle } {
  const addon = new SearchAddon();
  ctx.terminal.loadAddon(addon);

  // Cmd+F (mac) / Ctrl+F (other) opens the search bar.
  ctx.registerKeyHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") return undefined;
    const isMacKey = ctx.isMac ? e.metaKey : e.ctrlKey;
    if (
      isMacKey &&
      !e.shiftKey &&
      !e.altKey &&
      !(ctx.isMac && e.ctrlKey) &&
      e.key.toLowerCase() === "f"
    ) {
      e.preventDefault();
      ctx.openSearch();
      return false;
    }
    return undefined;
  }, 5); // Priority 5 — runs before CSI-u

  const search: SearchHandle = {
    findNext: (term, opts) => addon.findNext(term, opts) ?? false,
    findPrevious: (term, opts) => addon.findPrevious(term, opts) ?? false,
    clearActiveDecoration: () => addon.clearActiveDecoration(),
    addon,
  };

  return {
    search,
    dispose() {
      addon.dispose();
    },
  };
}
