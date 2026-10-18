/**
 * Web URL and OSC 8 link integration (checklist items #10, #11).
 *
 * - Loads WebLinksAddon so http/https URLs in terminal output are clickable.
 * - Replaces xterm's default linkHandler (which would call confirm() + window.open)
 *   with a host-IPC call to main/terminal-host-ipc.ts.
 * - Modifier: Cmd on mac, Ctrl elsewhere.
 */

import { WebLinksAddon } from "@xterm/addon-web-links";
import type { HostContext, IDisposable } from "./context";

function openLink(url: string): void {
  void window.harbormaster.terminalHost.openLink(url);
}

export function installLinks(ctx: HostContext): IDisposable {
  const { terminal, isMac } = ctx;

  function shouldActivate(e: MouseEvent): boolean {
    return isMac ? e.metaKey : e.ctrlKey;
  }

  // WebLinksAddon handles http/https URLs (text printed by processes).
  const webLinks = new WebLinksAddon((event, uri) => {
    if (shouldActivate(event)) openLink(uri);
  });
  terminal.loadAddon(webLinks);

  // OSC 8 hyperlinks: override xterm's default handler to route through IPC.
  terminal.options.linkHandler = {
    activate(event: MouseEvent, uri: string) {
      if (shouldActivate(event)) openLink(uri);
    },
    allowNonHttpProtocols: false,
  };

  return {
    dispose() {
      webLinks.dispose();
      // Reset to default (will fall back to xterm's built-in handler).
      // biome-ignore lint/suspicious/noExplicitAny: exactOptionalPropertyTypes requires null to clear an optional prop
      (terminal.options as any).linkHandler = null;
    },
  };
}
