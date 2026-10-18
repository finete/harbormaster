/**
 * Clipboard paste integration for terminal panes (checklist item #1, #2, #4).
 *
 * Intercepts the browser `paste` event on the terminal container (capture
 * phase, before xterm sees it) and routes through the main-process
 * `resolveClipboardPaste` handler, which can return image paths and
 * Finder file paths that the DOM clipboard API can't reach.
 */

import type { HostContext, IDisposable } from "./context";

/**
 * Perform a paste from the clipboard into the terminal.
 *
 * Exported so context-menu "Paste" can call the same path.
 */
export async function pasteFromClipboard(ctx: HostContext): Promise<void> {
  const text = await window.harbormaster.terminalHost.resolveClipboardPaste();
  if (text) ctx.terminal.paste(text);
}

/**
 * Install a capture-phase `paste` listener on the terminal container.
 * Returns a disposable that removes it.
 */
export function installPaste(ctx: HostContext): IDisposable {
  const handler = (e: ClipboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    void pasteFromClipboard(ctx);
  };

  // Capture phase so we intercept before xterm's own listener on the textarea.
  ctx.container.addEventListener("paste", handler, true);

  return {
    dispose() {
      ctx.container.removeEventListener("paste", handler, true);
    },
  };
}
