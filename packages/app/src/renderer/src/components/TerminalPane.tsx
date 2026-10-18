import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  createTerminalOptions,
  type HostContext,
  installHostIntegrations,
  type SearchHandle,
} from "../lib/terminal-host";
import {
  createTitleThrottle,
  defaultTerminalTitle,
  piTerminalTitle,
} from "../lib/terminal-title";
import { TerminalContextMenu } from "./TerminalContextMenu";
import { TerminalSearchBar } from "./TerminalSearchBar";

/**
 * One xterm.js terminal wired over the narrow `window.harbormaster.terminal`
 * IPC bridge to a node-pty `$SHELL` process spawned in the main process.
 *
 * xterm 6.0.0, with:
 * - Unicode11Addon (item #13)
 * - WebLinksAddon + OSC 8 handler (items #10, #11)
 * - SearchAddon + TerminalSearchBar (item #12)
 * - Cmd+K clear, mac text-editing sequences, extended CSI-u (items #7, #6, #8)
 * - Clipboard paste: image → tmp file, Finder files → paths (items #1, #2)
 * - Drag-and-drop files → paths (item #3)
 * - Right-click context menu (item #16)
 * - convertEol removed (item #25)
 * - macOptionClickForcesSelection: true (item #21)
 * - PTY env hygiene: TERM_PROGRAM, COLORTERM, LANG (item #24) — in ptySessions.ts
 */
export function TerminalPane(props: IDockviewPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hasReceivedOutput, setHasReceivedOutput] = useState(false);
  const [fellBackToShell, setFellBackToShell] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);

  // Search bar state.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchHandleRef = useRef<SearchHandle | null>(null);

  // Context menu state.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    ctx: HostContext;
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal(createTerminalOptions());

    // Unicode 11 width tables — must be loaded before open() so the first
    // render uses the correct glyph widths.
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = "11";

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    // Add a data attribute so e2e can assert the unicode version without
    // relying on canvas internals.
    container
      .closest("[data-testid='terminal-panel']")
      ?.setAttribute("data-unicode-version", "11");

    // WebGL renderer — fall back silently if context is unavailable.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl?.dispose());
      terminal.loadAddon(webgl);
    } catch {
      // DOM renderer fallback is fine.
    }

    fitAddon.fit();

    let disposed = false;
    let sessionId: string | undefined;

    const params = props.params as
      | { cwd?: string; taskId?: string; primary?: boolean }
      | undefined;
    const cwd = params?.cwd;
    const isPrimary = !!params?.primary;
    const isMac = /mac/i.test(navigator.platform);

    // HostContext ties together all feature installers.
    const ctx: HostContext = {
      terminal,
      container,
      write: (data: string) => {
        if (sessionId) window.harbormaster.terminal.write(sessionId, data);
      },
      isPrimary,
      isMac,
      openSearch: () => setSearchOpen(true),
      openContextMenu: (x, y) => setContextMenu({ x, y, ctx }),
      // registerKeyHandler is populated by installKeys() during installHostIntegrations().
      registerKeyHandler: () => {},
    };

    // Install all host integrations (keys, paste, drop, links, search, context-menu).
    const integrations = installHostIntegrations(ctx);
    searchHandleRef.current = integrations.search;

    let unsubscribeData: (() => void) | undefined;
    let unsubscribeExit: (() => void) | undefined;

    // Tab title (cmux parity).
    const initialTitle = defaultTerminalTitle({ cwd, primary: isPrimary });
    props.api.setTitle(initialTitle);
    const titleThrottle = createTitleThrottle(
      (title) => props.api.setTitle(title),
      { initial: initialTitle },
    );
    const titleDisposable = terminal.onTitleChange((title) => {
      if (!title) return;
      titleThrottle.update(isPrimary ? piTerminalTitle(title) : title);
    });

    // Deferred one macrotask: React StrictMode (dev) double-mounts effects.
    const createTimer = window.setTimeout(() => {
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

          let receivedOutput = false;
          unsubscribeData = window.harbormaster.terminal.onData((event) => {
            if (event.id !== id) return;
            const chars = event.data.length;
            terminal.write(event.data, () => {
              if (!disposed) window.harbormaster.terminal.ack(id, chars);
            });
            if (!receivedOutput) {
              receivedOutput = true;
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
    }, 0);

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
      window.clearTimeout(createTimer);
      titleDisposable.dispose();
      titleThrottle.dispose();
      resizeObserver.disconnect();
      integrations.dispose();
      unsubscribeData?.();
      unsubscribeExit?.();
      if (sessionId) void window.harbormaster.terminal.dispose(sessionId);

      // Workaround for addon-webgl ≤0.19 cursor-blink-manager leak (Tabby
      // webglAddon.ts workaround; remove once addon-webgl ≥0.20 is adopted):
      if (webgl) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: internal workaround
          (webgl as any)._renderer?._cursorBlinkStateManager?.dispose();
        } catch {
          // Safe to ignore.
        }
        try {
          webgl.dispose();
        } catch {
          // Context already lost.
        }
      }

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
        className="terminal-host relative min-h-0 flex-1 bg-[#0b0f14] py-1.5 pl-3"
      >
        {/* Search bar (item #12) */}
        {searchOpen && searchHandleRef.current && (
          <TerminalSearchBar
            search={searchHandleRef.current}
            onClose={() => {
              setSearchOpen(false);
              // Restore terminal focus when search closes.
              containerRef.current
                ?.querySelector<HTMLElement>(".xterm-helper-textarea")
                ?.focus();
            }}
          />
        )}

        {/* Context menu (item #16) */}
        {contextMenu && (
          <TerminalContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            ctx={contextMenu.ctx}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* xterm mounts here; padding lives on the wrapper above so the
            FitAddon measures the true content box. */}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
