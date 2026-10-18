/**
 * Unified keyboard handler for terminal host features.
 *
 * Owns the single `attachCustomKeyEventHandler` call on the terminal.  Each
 * feature (CSI-u, mac text editing, Cmd+K, etc.) registers a handler via
 * `installKeys`.  Handlers run in priority order; the first one to return
 * `false` wins (= "I handled it, suppress xterm's own handling").
 *
 * Returning `true` or `undefined` means "not mine, keep going".
 */

import {
  csiUSequenceForKeyEvent,
  macTextEditingSequence,
} from "../terminal-key-sequences";
import type { HostContext, IDisposable } from "./context";

interface KeyHandler {
  fn: (e: KeyboardEvent) => boolean | undefined;
  priority: number;
}

/**
 * Install the unified key handler.  The returned disposable disposes xterm's
 * `attachCustomKeyEventHandler` by replacing it with a no-op (xterm has no
 * API to remove the handler, but replacing with one that always returns true
 * effectively restores default behaviour).
 */
export function installKeys(ctx: HostContext): IDisposable {
  const handlers: KeyHandler[] = [];

  // Register a handler — lower priority number runs first.
  ctx.registerKeyHandler = (fn, priority) => {
    handlers.push({ fn, priority });
    handlers.sort((a, b) => a.priority - b.priority);
  };

  // --- Built-in handlers ---

  // Priority 10: Cmd+K clear (P1, item #7).
  handlers.push({
    priority: 10,
    fn: (e: KeyboardEvent) => {
      if (!ctx.isMac) return undefined;
      if (
        e.type === "keydown" &&
        e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        ctx.terminal.clear();
        return false;
      }
      return undefined;
    },
  });

  // Priority 20: macOS word/line navigation (P0, item #6).
  handlers.push({
    priority: 20,
    fn: (e: KeyboardEvent) => {
      const seq = macTextEditingSequence(e, { isMac: ctx.isMac });
      if (seq === null) return undefined;
      e.preventDefault();
      ctx.write(seq);
      return false;
    },
  });

  // Priority 30: CSI-u extended keys (P0/P1, items #8 + existing set).
  handlers.push({
    priority: 30,
    fn: (e: KeyboardEvent) => {
      const seq = csiUSequenceForKeyEvent(e);
      if (seq === null) return undefined;
      e.preventDefault();
      ctx.write(seq);
      return false;
    },
  });

  // Attach a single handler that runs all registered ones in priority order.
  ctx.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    for (const { fn } of handlers) {
      const result = fn(e);
      if (result === false) return false;
    }
    return true;
  });

  return {
    dispose() {
      // Replace with a pass-through so default xterm handling resumes.
      ctx.terminal.attachCustomKeyEventHandler(() => true);
    },
  };
}
