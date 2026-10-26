import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  captureWebglContext,
  createTerminalOptions,
  createWebglParker,
  type HostContext,
  installHostIntegrations,
  isContainerVisible,
  registerResettablePane,
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
    terminal.open(container);

    // Add a data attribute so e2e can assert the unicode version without
    // relying on canvas internals.
    container
      .closest("[data-testid='terminal-panel']")
      ?.setAttribute("data-unicode-version", "11");

    // WebGL renderer with LRU-friendly re-acquisition (P0-3).
    // See terminal-perf-checklist.md §c P0-3 for the full rationale.
    //
    // 1. Set data-renderer on the terminal-panel element for e2e/diagnostics.
    // 2. On context loss: dispose, switch to DOM, refit for correct cell metrics,
    //    note timestamp.
    // 3. Re-acquire WebGL lazily when visible again (ResizeObserver fires with
    //    non-zero rect after being hidden), provided < 3 losses in 5 minutes.
    // After 3 losses in 5 min we stay on DOM (likely a sick GPU — VS Code's
    // _suggestedRendererType='dom' idea).
    // 4. Park: a pane hidden for longer than WEBGL_PARK_DELAY_MS (10 s) drops
    //    its WebGL addon AND explicitly frees the context (loseContext after
    //    dispose — a disposed context otherwise lingers until GC, which is
    //    what xterm #6068 is about), data-renderer="parked". Showing it again
    //    re-loads WebGL. A quick hide/show (tab flick) never touches the GPU,
    //    so the atlas rebuild cost is only paid after a real absence. Parking
    //    is not a loss and does not count toward the 3-loss cap.

    let disposed = false;
    let sessionId: string | undefined;

    const terminalPanel = container.closest(
      "[data-testid='terminal-panel']",
    ) as HTMLElement | null;

    // Context-loss timestamps, oldest first; trimmed in place to the 5-min
    // window so it never grows with uptime.
    const losses: number[] = [];
    let webglLost = false;

    function recentLossCount(): number {
      const cutoff = Date.now() - 5 * 60 * 1000;
      let stale = 0;
      while (stale < losses.length && (losses[stale] ?? 0) < cutoff) stale++;
      if (stale > 0) losses.splice(0, stale);
      return losses.length;
    }

    function setRenderer(r: "webgl" | "dom" | "parked"): void {
      terminalPanel?.setAttribute("data-renderer", r);
    }

    let webgl: WebglAddon | undefined;

    function disposeWebgl(): void {
      const addon = webgl;
      if (!addon) return;
      // Cleared first: the onContextLoss handler ignores any addon that is no
      // longer the current one, so our own loseContext() below (or a late
      // event from this addon) is never mistaken for a real GPU loss.
      webgl = undefined;
      // Tabby cursor-blink-manager workaround (addon-webgl ≤0.19).
      try {
        // biome-ignore lint/suspicious/noExplicitAny: internal workaround
        (addon as any)._renderer?._cursorBlinkStateManager?.dispose();
      } catch {}
      // Grab the GL context before dispose() drops the renderer; lose it
      // after, once the addon's webglcontextlost listener is gone.
      const context = captureWebglContext(addon);
      try {
        addon.dispose();
      } catch {}
      context?.loseContext();
    }

    function loadWebgl(): void {
      if (disposed) return;
      try {
        disposeWebgl();
        const addon = new WebglAddon();
        webgl = addon;
        addon.onContextLoss(() => {
          if (disposed || webgl !== addon) return;
          webglLost = true;
          losses.push(Date.now());
          disposeWebgl();
          setRenderer("dom");
          // DOM cell metrics differ from WebGL, so refit — but only when laid
          // out. Chromium usually evicts a HIDDEN pane's context, and fitting
          // a display:none pane proposes 11x6 (reflowing scrollback and
          // SIGWINCHing pi); the ResizeObserver refits on show instead.
          if (isContainerVisible(container)) fitAddon.fit();
          if (recentLossCount() >= 3) {
            console.warn(
              "[terminal] WebGL context lost 3+ times in 5 min; staying on DOM renderer",
            );
          }
        });
        terminal.loadAddon(addon);
        webglLost = false;
        setRenderer("webgl");
      } catch {
        webgl = undefined;
        setRenderer("dom");
      }
    }

    const parker = createWebglParker({
      park: () => {
        if (disposed || !webgl) return;
        disposeWebgl();
        setRenderer("parked");
      },
      unpark: () => {
        if (disposed || webgl || recentLossCount() >= 3) return;
        loadWebgl();
        if (isContainerVisible(container)) fitAddon.fit();
      },
    });
    // 5. Coordinated reset (renderer-reset.ts): on system resume / screen
    //    unlock (or focus after a long absence) EVERY pane drops WebGL in
    //    the same tick, so the shared glyph atlas loses its last owner and
    //    is discarded, then each restores on the next frame with a fresh
    //    context + atlas. Fixes panes left blank by a backing store the GPU
    //    discarded without a context-loss event.
    let droppedForReset = false;
    const unregisterReset = registerResettablePane({
      drop: () => {
        droppedForReset = webgl !== undefined;
        if (droppedForReset) disposeWebgl();
      },
      restore: () => {
        if (disposed) return;
        const reload = droppedForReset;
        droppedForReset = false;
        // A pane parked in between stays parked; unpark re-loads on show.
        if (reload && !webgl && !parker.isParked() && recentLossCount() < 3) {
          loadWebgl();
        }
        if (isContainerVisible(container)) fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
      },
    });

    // Visible = intersecting the viewport (IntersectionObserver) AND laid out
    // with a real size (ResizeObserver below). Covers both display:none task
    // workspaces and dockview tabs detached from the document.
    let intersecting = true;
    function updateVisibility(): void {
      parker.setVisible(intersecting && isContainerVisible(container));
    }
    const intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) intersecting = entry.isIntersecting;
      updateVisibility();
    });
    intersectionObserver.observe(container);

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

    loadWebgl();

    fitAddon.fit();

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
          if (attached) void window.harbormaster.terminal.dispose(attached.id);
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
          .then(({ id, fellBackToShell: fellBack }) => {
            if (disposed) {
              void window.harbormaster.terminal.dispose(id);
              return;
            }
            if (fellBack) setFellBackToShell(true);
            wireSession(id);
          });
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
      // Before fitting: on show this unparks (reloads WebGL) first, so the
      // single fit below measures with the final renderer's cell metrics.
      updateVisibility();
      if (!container.isConnected || !r || r.width === 0 || r.height === 0) {
        return;
      }
      fitAddon.fit();
      // pty resize is forwarded by terminal.onResize above.

      // P0-3: re-acquire WebGL when this pane becomes visible after a
      // context loss, if we haven't hit the 3-loss-in-5-min threshold.
      if (webglLost && !webgl && !disposed && recentLossCount() < 3) {
        loadWebgl();
      }
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      window.clearTimeout(createTimer);
      titleDisposable.dispose();
      titleThrottle.dispose();
      resizeDisposable.dispose();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      parker.dispose();
      unregisterReset();
      integrations.dispose();
      unsubscribeData?.();
      unsubscribeExit?.();
      unsubscribeA11y();
      if (sessionId) void window.harbormaster.terminal.dispose(sessionId);

      // P0-3: disposeWebgl() handles the Tabby cursor-blink-manager workaround
      // (addon-webgl ≤0.19), frees the GL context right away (StrictMode's
      // throwaway mount no longer holds one until GC), and is a no-op when
      // webgl is undefined.
      disposeWebgl();

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
