/**
 * Terminal options factory (checklist items #25, #13, #21, #26).
 *
 * Centralises xterm ITerminalOptions so Chunk F changes are in one place.
 */

import type { ITerminalOptions } from "@xterm/xterm";

export function createTerminalOptions(): ITerminalOptions {
  return {
    // Note: convertEol is intentionally NOT set (item #25).
    // With convertEol:true, every bare LF from curses apps (vim, htop, etc.)
    // would move the cursor to column 0, corrupting the display.
    cursorBlink: true,
    fontFamily:
      '"Hack Nerd Font Mono", "HackNerdFontMono", "MesloLGS NF", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1,
    scrollback: 10_000,
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
    theme: {
      background: "#0b0f14",
      foreground: "#d7dde3",
      cursor: "#d7dde3",
      cursorAccent: "#0b0f14",
      selectionBackground: "#2c3a4d",
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
