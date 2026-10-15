import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { defaultTerminalTitle, piTerminalTitle } from "../lib/terminal-title";

/**
 * One xterm.js terminal wired over the narrow `window.harbormaster.terminal`
 * IPC bridge to a node-pty `$SHELL` process spawned in the main process.
 */
export function TerminalPane(props: IDockviewPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Flips once the pty has written any bytes back to this pane. Exposed as a
  // data attribute so e2e tests can assert on "pty is alive and talking"
  // without depending on xterm's canvas-rendered internals.
  const [hasReceivedOutput, setHasReceivedOutput] = useState(false);
  // Set when this panel tried to launch pi and fell back to a plain shell
  // (pi not installed/found on PATH); renders a dismissible warning strip.
  const [fellBackToShell, setFellBackToShell] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);

  // Mount-only: this pty is spawned exactly once for this panel's
  // lifetime, with the cwd dockview assigned it at creation time (see
  // TaskWorkspace.tsx) — a panel's params never change after that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect, see comment above.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      // Nerd Font first so powerline/p10k prompts render their glyphs; the
      // fallbacks keep the terminal usable on machines without it.
      fontFamily:
        '"Hack Nerd Font Mono", "HackNerdFontMono", "MesloLGS NF", Menlo, monospace',
      fontSize: 13,
      // No lineHeight multiplier: fractional cell heights (13 * 1.25 = 16.25px)
      // land the WebGL glyph atlas on subpixel boundaries and blur every
      // glyph, especially on retina. Integer cells = Ghostty-crisp text.
      lineHeight: 1,
      scrollback: 10_000,
      macOptionIsMeta: true,
      // Never let xterm recolor output for contrast; themes own their colors.
      minimumContrastRatio: 1,
      // Keeps an accessible text mirror of the terminal's rendered rows in
      // the DOM alongside the canvas paint, so e2e tests can assert on
      // terminal contents (shell output, prompts) via plain text matchers.
      screenReaderMode: true,
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
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    // WebGL paints crisper and faster than the DOM renderer; fall back
    // silently when the context is unavailable (rare: headless GL limits,
    // too many live contexts). On context loss, dispose so xterm returns to
    // its default renderer instead of a frozen canvas.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch {
      // DOM renderer fallback is fine.
    }
    fitAddon.fit();

    let disposed = false;
    let sessionId: string | undefined;
    let unsubscribeData: (() => void) | undefined;
    let unsubscribeExit: (() => void) | undefined;

    const params = props.params as
      | { cwd?: string; taskId?: string; primary?: boolean }
      | undefined;
    const cwd = params?.cwd;
    const isPrimary = !!params?.primary;

    // Live tab title (cmux parity): default to "π" (primary/pi panes) or
    // the cwd's basename (plain shells) until xterm reports the shell's
    // first OSC title, then track every change verbatim (prefixed "π " for
    // primary panes). Routed through dockview's panel api, not React state,
    // so a title change never re-renders/remounts this panel.
    props.api.setTitle(defaultTerminalTitle({ cwd, primary: isPrimary }));
    const titleDisposable = terminal.onTitleChange((title) => {
      if (!title) return;
      props.api.setTitle(isPrimary ? piTerminalTitle(title) : title);
    });

    void window.harbormaster.terminal
      .create({
        cols: terminal.cols,
        rows: terminal.rows,
        ...(cwd ? { cwd } : {}),
        ...(params?.taskId ? { taskId: params.taskId } : {}),
        ...(params?.primary ? { primary: true } : {}),
      })
      .then(({ id, fellBackToShell: fellBack }) => {
        if (disposed) {
          void window.harbormaster.terminal.dispose(id);
          return;
        }
        sessionId = id;
        if (fellBack) setFellBackToShell(true);

        unsubscribeData = window.harbormaster.terminal.onData((event) => {
          if (event.id === id) {
            terminal.write(event.data);
            setHasReceivedOutput(true);
          }
        });
        unsubscribeExit = window.harbormaster.terminal.onExit((event) => {
          if (event.id === id) {
            terminal.writeln(
              `\r\n[process exited with code ${event.exitCode}]`,
            );
          }
        });

        terminal.onData((data) => {
          window.harbormaster.terminal.write(id, data);
        });
      });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (sessionId) {
        window.harbormaster.terminal.resize(
          sessionId,
          terminal.cols,
          terminal.rows,
        );
      }
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      titleDisposable.dispose();
      resizeObserver.disconnect();
      unsubscribeData?.();
      unsubscribeExit?.();
      if (sessionId) void window.harbormaster.terminal.dispose(sessionId);
      // xterm's dispose cascades into loaded addons; the WebGL addon can
      // throw when its context is already torn down. A throw inside a React
      // cleanup unmounts the entire tree, so never let it escape.
      try {
        terminal.dispose();
      } catch {
        // Renderer teardown raced the GL context; nothing left to free.
      }
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      {fellBackToShell && !warningDismissed && (
        <div
          data-testid="pi-fallback-warning"
          className="flex items-center justify-between gap-2 bg-amber-900/60 px-2 py-1 text-xs text-amber-200"
        >
          <span>pi not found — opened a plain shell</span>
          <button
            type="button"
            data-testid="pi-fallback-warning-dismiss"
            onClick={() => setWarningDismissed(true)}
            className="shrink-0 rounded px-1.5 py-0.5 text-amber-100 hover:bg-amber-800/60"
          >
            Dismiss
          </button>
        </div>
      )}
      <div
        data-testid="terminal-panel"
        data-panel-id={props.api.id}
        data-received-output={hasReceivedOutput}
        className="terminal-host min-h-0 flex-1 bg-[#0b0f14] py-1.5 pl-3"
      >
        {/* xterm mounts here; padding lives on the wrapper above so the
            FitAddon measures the true content box — padding on the measured
            element makes fit overshoot and clip the bottom row (pi's footer). */}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
