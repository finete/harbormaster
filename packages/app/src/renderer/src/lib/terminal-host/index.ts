/**
 * Terminal host integration entry point (Chunk 0).
 *
 * Calls all feature installers and returns a single combined disposable.
 * TerminalPane calls this after terminal.open() and disposes it in cleanup.
 */

import type { HostContext, IDisposable } from "./context";
import { combineDisposables } from "./context";
import { installContextMenu } from "./context-menu";
import { installDrop } from "./drop";
import { installKeys } from "./keys";
import { installLinks } from "./links";
import { installPaste } from "./paste";
import { installSearch } from "./search";

export { dropInsertText } from "./drop";
export { createTerminalOptions } from "./options";
export { pasteFromClipboard } from "./paste";
export type { SearchHandle } from "./search";
export type { HostContext, IDisposable };
export { combineDisposables };

export interface HostIntegrations extends IDisposable {
  search: ReturnType<typeof installSearch>["search"];
}

/**
 * Install all terminal host integrations.
 *
 * @param ctx  The fully-populated HostContext (terminal, container, write, etc.)
 */
export function installHostIntegrations(ctx: HostContext): HostIntegrations {
  const keys = installKeys(ctx);
  const paste = installPaste(ctx);
  const drop = installDrop(ctx);
  const links = installLinks(ctx);
  const searchResult = installSearch(ctx);
  const contextMenu = installContextMenu(ctx);

  const combined = combineDisposables(
    keys,
    paste,
    drop,
    links,
    searchResult,
    contextMenu,
  );

  return {
    search: searchResult.search,
    dispose() {
      combined.dispose();
    },
  };
}
