import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      theme: {
        background: "#0b0f14",
        foreground: "#d7dde3",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    let disposed = false;
    let sessionId: string | undefined;
    let unsubscribeData: (() => void) | undefined;
    let unsubscribeExit: (() => void) | undefined;

    void window.harbormaster.terminal
      .create({ cols: terminal.cols, rows: terminal.rows })
      .then(({ id }) => {
        if (disposed) {
          void window.harbormaster.terminal.dispose(id);
          return;
        }
        sessionId = id;

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
      resizeObserver.disconnect();
      unsubscribeData?.();
      unsubscribeExit?.();
      if (sessionId) void window.harbormaster.terminal.dispose(sessionId);
      terminal.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-panel"
      data-panel-id={props.api.id}
      data-received-output={hasReceivedOutput}
      className="h-full w-full p-1"
    />
  );
}
