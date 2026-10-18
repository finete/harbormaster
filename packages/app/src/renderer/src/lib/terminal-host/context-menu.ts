/**
 * Right-click context menu for terminal panes (checklist item #16).
 *
 * Intercepts the `contextmenu` event and opens the TerminalContextMenu
 * component via ctx.openContextMenu(x, y).
 */

import type { HostContext, IDisposable } from "./context";

export function installContextMenu(ctx: HostContext): IDisposable {
  const handler = (e: MouseEvent) => {
    e.preventDefault();
    ctx.openContextMenu(e.clientX, e.clientY);
  };

  ctx.container.addEventListener("contextmenu", handler);

  return {
    dispose() {
      ctx.container.removeEventListener("contextmenu", handler);
    },
  };
}
