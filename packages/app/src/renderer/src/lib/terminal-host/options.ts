/**
 * Terminal options factory (checklist items #25, #13, #21, #26).
 *
 * Centralises xterm ITerminalOptions so Chunk F changes are in one place.
 */

import type { ITerminalOptions } from "@xterm/xterm";

/** Scrollback for the primary (pi) pane: the agent transcript lives here. */
export const PRIMARY_SCROLLBACK = 10_000;
/**
 * Scrollback for secondary split shells. Each buffer line costs
 * roughly cols × 12 bytes and panes never shrink it, so halve the cap for
 * panes whose history matters less.
 */
export const SHELL_SCROLLBACK = 5_000;

/** The work-area ground token (`--background`, #1e1e1e): the terminal canvas. */
export const TERMINAL_BACKGROUND = "#1e1e1e";

export function createTerminalOptions(
  opts: { primary?: boolean } = {},
): ITerminalOptions {
  return {
    // Note: convertEol is intentionally NOT set (item #25).
    // With convertEol:true, every bare LF from curses apps (vim, htop, etc.)
    // would move the cursor to column 0, corrupting the display.
    cursorBlink: true,
    fontFamily:
      '"Hack Nerd Font Mono", "HackNerdFontMono", "MesloLGS NF", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1,
    scrollback: opts.primary ? PRIMARY_SCROLLBACK : SHELL_SCROLLBACK,
    macOptionIsMeta: true,
    // Allow text selection to override mouse-reporting mode (item #21):
    // Option-click forces a selection even when the pty has enabled
    // ?1000/1002/1003h mouse reporting (e.g. pi fullscreen).
    macOptionClickForcesSelection: true,
    scrollOnUserInput: true,
    minimumContrastRatio: 1,
    // screenReaderMode is OFF by default in production (P1-1).
    // It adds per-row forced layouts (AccessibilityManager.ts:422-433) that
    // cost ~10-25% extra CPU on slow machines. The renderer enables it at
    // runtime when (a) the OS reports an assistive technology via
    // app.isAccessibilitySupportEnabled(), or (b) the e2e env var
    // HARBORMASTER_TERMINAL_A11Y_MIRROR=1 is set (playwright.config.ts).
    // See main/index.ts and TerminalPane.tsx for the IPC path.
    screenReaderMode: false,
    // allowProposedApi is required for the (EXPERIMENTAL) terminal.unicode
    // property used by Unicode11Addon (item #13).
    allowProposedApi: true,
    // Design tokens (docs/design-system.md): ground #1e1e1e, mint #9eebd9
    // cursor, selection = mint at ~25% (0x40). Foreground and the 16 ANSI
    // colors are the "Apple System Colors" palette (Ghostty theme set),
    // which reads well on the neutral grey ground.
    theme: {
      background: TERMINAL_BACKGROUND,
      foreground: "#ffffff",
      cursor: "#9eebd9",
      cursorAccent: TERMINAL_BACKGROUND,
      selectionBackground: "#9eebd940",
      selectionInactiveBackground: "#9eebd926",
      scrollbarSliderBackground: "#33343580",
      scrollbarSliderHoverBackground: "#333435",
      scrollbarSliderActiveBackground: "#383839",
      black: "#1a1a1a",
      red: "#cc372e",
      green: "#26a439",
      yellow: "#cdac08",
      blue: "#0869cb",
      magenta: "#9647bf",
      cyan: "#479ec2",
      white: "#98989d",
      brightBlack: "#464646",
      brightRed: "#ff453a",
      brightGreen: "#32d74b",
      brightYellow: "#ffd60a",
      brightBlue: "#0a84ff",
      brightMagenta: "#bf5af2",
      brightCyan: "#76d6ff",
      brightWhite: "#ffffff",
    },
  };
}
