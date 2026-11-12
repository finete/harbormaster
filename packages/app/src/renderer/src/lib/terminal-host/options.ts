/**
 * Terminal options factory (checklist items #25, #13, #21, #26).
 *
 * Centralises xterm ITerminalOptions so Chunk F changes are in one place.
 */

import type { ITerminalOptions } from "@xterm/xterm";

/** Scrollback for the primary (pi) pane: the agent transcript lives here. */
export const PRIMARY_SCROLLBACK = 10_000;
/**
 * Scrollback for secondary "+ terminal" shells. Each buffer line costs
 * roughly cols × 12 bytes and panes never shrink it, so halve the cap for
 * panes whose history matters less.
 */
export const SHELL_SCROLLBACK = 5_000;

/** The window ground token (`--background`, #0a0b0c): the terminal canvas. */
export const TERMINAL_BACKGROUND = "#0a0b0c";

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
    // Design tokens (docs/design-system.md): ground #0a0b0c, foreground
    // #f2f4f5, mint #6ef5d6 cursor, selection = mint at ~25% (0x40).
    theme: {
      background: TERMINAL_BACKGROUND,
      foreground: "#f2f4f5",
      cursor: "#6ef5d6",
      cursorAccent: TERMINAL_BACKGROUND,
      selectionBackground: "#6ef5d640",
      selectionInactiveBackground: "#6ef5d626",
      scrollbarSliderBackground: "#22252780",
      scrollbarSliderHoverBackground: "#222527",
      scrollbarSliderActiveBackground: "#1c2023",
      black: "#1c2126",
      red: "#f2777a",
      green: "#99cc99",
      yellow: "#ffcc66",
      blue: "#6699cc",
      magenta: "#cc99cc",
      cyan: "#66cccc",
      white: "#d7dde3",
      brightBlack: "#4a5561",
      brightRed: "#f99157",
      brightGreen: "#b5e0a6",
      brightYellow: "#ffd98c",
      brightBlue: "#8ab6e8",
      brightMagenta: "#e0b3e0",
      brightCyan: "#8ce0e0",
      brightWhite: "#f2f6fa",
    },
  };
}
