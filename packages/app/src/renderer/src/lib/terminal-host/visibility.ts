/**
 * Whether a pane's container is laid out with a real size. A detached or
 * `display:none` container would make FitAddon propose a garbage 11×6 size
 * (it parses the computed "100%" width/height as 100px), which reflows the
 * scrollback and SIGWINCHes the pty.
 */
export function isContainerVisible(el: {
  isConnected: boolean;
  clientWidth: number;
  clientHeight: number;
}): boolean {
  return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
}
