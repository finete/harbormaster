import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  createTerminalOptions,
  type HostContext,
  installHostIntegrations,
  isContainerVisible,
  type SearchHandle,
} from "../lib/terminal-host";
import { registerTaskTerminal } from "../lib/terminal-tail";
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
  const [missingCommand, setMissingCommand] = useState("pi");
  const [worktreeMissing, setWorktreeMissing] = useState(false);
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
    const mountEl = containerRef.current;
    if (!mountEl) return;
    // Non-null alias so hoisted helper functions below keep the narrowing.
    const container: HTMLDivElement = mountEl;

    const params = props.params as
      | { cwd?: string; taskId?: string; primary?: boolean }
      | undefined;
    const cwd = params?.cwd;
    const isPrimary = !!params?.primary;

    const terminal = new Terminal(
      createTerminalOptions({ primary: isPrimary }),
    );

    // Unicode 11 width tables — must be loaded before open() so the first
    // render uses the correct glyph widths.
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = "11";

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    // Primary only: on close its last screen is handed to main with the
    // released pi, so reopening the tab shows it immediately.
    const serializeAddon = isPrimary ? new SerializeAddon() : undefined;
    if (serializeAddon) terminal.loadAddon(serializeAddon);
    terminal.open(container);

    // Add a data attribute so e2e can assert the unicode version without
    // relying on canvas internals.
    container
      .closest("[data-testid='terminal-panel']")
      ?.setAttribute("data-unicode-version", "11");

    // DOM renderer only: no @xterm/addon-webgl. After macOS sleep / lock
    // WebGL drew nothing for minutes, even on a brand-new context, while the
    // DOM renderer kept painting; and WebGL needed a growing pile of
    // workarounds (context parking, loss fallback, wake resets, shared glyph
    // atlas bugs). See docs/design-decisions.md "Terminal renderer: DOM".
    // data-renderer stays for e2e / diagnostics.
    let disposed = false;
    let sessionId: string | undefined;
    container
      .closest("[data-testid='terminal-panel']")
      ?.setAttribute("data-renderer", "dom");

    // P1-1: Enable screenReaderMode when OS reports AT or e2e env knob is set.
    // xterm supports runtime toggling; the mirror back-fills current rows when
    // enabled late (AccessibilityManager.ts:121-122), so enabling after open() is safe.
    void window.harbormaster.terminal.getScreenReaderMode().then((enabled) => {
      if (!disposed) terminal.options.screenReaderMode = enabled;
    });
    const unsubscribeA11y =
      window.harbormaster.terminal.onScreenReaderModeChanged((enabled) => {
        if (!disposed) terminal.options.screenReaderMode = enabled;
      });

    // Fit only when laid out. A pane mounted hidden (a background task's
    // workspace after an app restart) would get FitAddon's garbage 11x6, and
    // its pty would start at 11 columns. The ResizeObserver fits on show.
    if (isContainerVisible(container)) fitAddon.fit();

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

    // Tab title.
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

    // Shared wiring for whichever path actually starts streaming (a fresh
    // `create`, or an `attachPrimary` rebind to an already-running
    // background session) "-" same onData/onExit/write subscriptions either
    // way, so the pane behaves identically from here on (closing it kills
    // the pty, same as any normal primary pane).
    function wireSession(id: string): void {
      sessionId = id;
      let receivedOutput = false;
      // Subscribed by id: the preload routes each chunk to this session's
      // listeners only (one IPC listener total, not one per pane).
      unsubscribeData = window.harbormaster.terminal.onData((event) => {
        const chars = event.data.length;
        terminal.write(event.data, () => {
          if (!disposed) window.harbormaster.terminal.ack(id, chars);
        });
        if (!receivedOutput) {
          receivedOutput = true;
          setHasReceivedOutput(true);
        }
      }, id);
      unsubscribeExit = window.harbormaster.terminal.onExit((event) => {
        terminal.writeln(`\r\n[process exited with code ${event.exitCode}]`);
      }, id);

      terminal.onData((data) => {
        window.harbormaster.terminal.write(id, data);
      });
    }

    // Deferred one macrotask: React StrictMode (dev) double-mounts effects.
    const createTimer = window.setTimeout(() => {
      // The primary pane always tries to attach to an already-running
      // background launch first (wave-2 task brief point 4): if the task has
      // a live app-owned primary pty with no renderer attached yet, this
      // rebinds to it and returns its serialized screen instead of starting
      // a second process "-" the takeover guard never shows a dialog for it
      // (see core-client/App.tsx's `ownedByApp`) and this is what makes that
      // guarantee actually attach instead of silently doing nothing. Any
      // other pane (non-primary, no taskId, or a primary with nothing to
      // attach to) falls through to `create` exactly as before.
      const attachAttempt =
        isPrimary && params?.taskId
          ? window.harbormaster.terminal.attachPrimary(
              params.taskId,
              terminal.cols,
              terminal.rows,
            )
          : Promise.resolve(undefined);

      void attachAttempt.then((attached) => {
        if (disposed) {
          // Pane torn down during the attach race: hand the session back to
          // the background rather than killing it (see `terminal.release`).
          if (attached) void window.harbormaster.terminal.release(attached.id);
          return;
        }
        if (attached) {
          // Write the missed screen before switching to live streaming "-"
          // same recommendation as `@xterm/addon-serialize`'s own docs.
          terminal.write(attached.snapshot);
          wireSession(attached.id);
          return;
        }
        void window.harbormaster.terminal
          .create({
            cols: terminal.cols,
            rows: terminal.rows,
            ...(cwd ? { cwd } : {}),
            ...(params?.taskId ? { taskId: params.taskId } : {}),
            ...(params?.primary ? { primary: true } : {}),
          })
          .then(
            ({
              id,
              fellBackToShell: fellBack,
              worktreeMissing: wtGone,
              missingCommand: missing,
            }) => {
              if (disposed) {
                void window.harbormaster.terminal.release(id);
                return;
              }
              if (missing) setMissingCommand(missing);
              if (fellBack) setFellBackToShell(true);
              if (wtGone) setWorktreeMissing(true);
              wireSession(id);
            },
          );
      });
    }, 0);

    // P0-2: forward pty resizes only when xterm's cols/rows actually change.
    // xterm fires onResize only on real dimension changes, so this naturally
    // deduplicates. We do NOT call pty.resize from the ResizeObserver
    // that would send garbage 11x6 sizes when the pane is hidden/display:none.
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (sessionId) {
        window.harbormaster.terminal.resize(sessionId, cols, rows);
      }
    });

    const resizeObserver = new ResizeObserver((entries) => {
      // Guard: skip when hidden/detached (P0-2 fix). A zero-area contentRect
      // means display:none or no layout; fitting would propose a garbage 11x6
      // size (verified SIGWINCH in real app).
      const r = entries[entries.length - 1]?.contentRect;
      if (!container.isConnected || !r || r.width === 0 || r.height === 0) {
        return;
      }
      fitAddon.fit();
      // pty resize is forwarded by terminal.onResize above.
    });
    resizeObserver.observe(container);

    // The inbox detail pane reads a task's last lines from its mounted pane
    // (lib/terminal-tail.ts); main's headless mirror covers paneless tasks.
    const unregisterTail =
      isPrimary && params?.taskId
        ? registerTaskTerminal(params.taskId, () => terminal.buffer.active)
        : undefined;

    return () => {
      disposed = true;
      unregisterTail?.();
      window.clearTimeout(createTimer);
      titleDisposable.dispose();
      titleThrottle.dispose();
      resizeDisposable.dispose();
      resizeObserver.disconnect();
      integrations.dispose();
      unsubscribeData?.();
      unsubscribeExit?.();
      unsubscribeA11y();
      // Tab close / pane unmount: release (detach task primaries to the
      // background, dispose shells) instead of unconditionally killing, so
      // reopening re-attaches instantly and a working agent survives a tab
      // close. The xterm instance itself is always disposed.
      if (sessionId) {
        let screen: string | undefined;
        try {
          screen = serializeAddon?.serialize({ scrollback: 1000 });
        } catch {
          // Best effort: without it a reopen just starts from a blank mirror.
        }
        void window.harbormaster.terminal.release(sessionId, screen);
      }
      terminal.dispose();
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      {worktreeMissing && !warningDismissed && (
        <div
          data-testid="worktree-missing-warning"
          className="flex items-center justify-between gap-2 border-b border-status-needsYou/35 bg-status-needsYou/10 px-3 py-1.5 text-xs text-status-needsYou"
        >
          <span>
            Worktree folder is missing — pi was not started. Recreate it from
            this task's branch (
            <code>git worktree add &lt;path&gt; &lt;branch&gt;</code>) to
            resume, then reopen this session.
          </span>
          <button
            type="button"
            data-testid="worktree-missing-warning-dismiss"
            onClick={() => setWarningDismissed(true)}
            className="shrink-0 rounded px-1.5 py-0.5 text-foreground transition-colors duration-[120ms] ease-out hover:bg-accent"
          >
            Dismiss
          </button>
        </div>
      )}
      {fellBackToShell && !warningDismissed && (
        <div
          data-testid="pi-fallback-warning"
          className="flex items-center justify-between gap-2 border-b border-status-needsYou/35 bg-status-needsYou/10 px-3 py-1.5 text-xs text-status-needsYou"
        >
          <span>{missingCommand} not found — opened a plain shell</span>
          <button
            type="button"
            data-testid="pi-fallback-warning-dismiss"
            onClick={() => setWarningDismissed(true)}
            className="shrink-0 rounded px-1.5 py-0.5 text-foreground transition-colors duration-[120ms] ease-out hover:bg-accent"
          >
            Dismiss
          </button>
        </div>
      )}
      <div
        data-testid="terminal-panel"
        data-panel-id={props.api.id}
        data-received-output={hasReceivedOutput}
        className="terminal-host relative min-h-0 flex-1 bg-background py-1.5 pl-3"
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
