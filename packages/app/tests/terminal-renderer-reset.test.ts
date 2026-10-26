import { describe, expect, it, vi } from "vitest";
import {
  createRendererResetRegistry,
  shouldResetOnFocus,
} from "../src/renderer/src/lib/terminal-host/renderer-reset";

function manualFrames() {
  const queue: (() => void)[] = [];
  return {
    nextFrame: (fn: () => void) => queue.push(fn),
    flush: () => {
      for (const fn of queue.splice(0)) fn();
    },
    pending: () => queue.length,
  };
}

function pane(log: string[], name: string) {
  return {
    drop: vi.fn(() => log.push(`drop:${name}`)),
    restore: vi.fn(() => log.push(`restore:${name}`)),
  };
}

describe("renderer reset registry", () => {
  it("drops every pane before restoring any (shared atlas must lose all owners)", () => {
    const frames = manualFrames();
    const registry = createRendererResetRegistry(frames.nextFrame);
    const log: string[] = [];
    registry.register(pane(log, "a"));
    registry.register(pane(log, "b"));

    registry.resetAll();
    expect(log).toEqual(["drop:a", "drop:b"]);
    frames.flush();
    expect(log).toEqual(["drop:a", "drop:b", "restore:a", "restore:b"]);
  });

  it("coalesces a burst (resume + unlock) into one reset", () => {
    const frames = manualFrames();
    const registry = createRendererResetRegistry(frames.nextFrame);
    const p = pane([], "a");
    registry.register(p);

    registry.resetAll();
    registry.resetAll();
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(p.drop).toHaveBeenCalledTimes(1);
    expect(p.restore).toHaveBeenCalledTimes(1);

    // A later reset runs again.
    registry.resetAll();
    frames.flush();
    expect(p.drop).toHaveBeenCalledTimes(2);
  });

  it("skips restoring a pane unregistered between drop and restore", () => {
    const frames = manualFrames();
    const registry = createRendererResetRegistry(frames.nextFrame);
    const p = pane([], "a");
    const unregister = registry.register(p);

    registry.resetAll();
    unregister();
    frames.flush();
    expect(p.restore).not.toHaveBeenCalled();
    expect(registry.size()).toBe(0);
  });

  it("one failing pane does not block the others", () => {
    const frames = manualFrames();
    const registry = createRendererResetRegistry(frames.nextFrame);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log: string[] = [];
    registry.register({
      drop: () => {
        throw new Error("boom");
      },
      restore: () => {
        throw new Error("boom");
      },
    });
    registry.register(pane(log, "b"));

    registry.resetAll();
    frames.flush();
    expect(log).toEqual(["drop:b", "restore:b"]);
    warn.mockRestore();
  });
});

describe("shouldResetOnFocus", () => {
  it("resets only after a long enough absence", () => {
    expect(shouldResetOnFocus(undefined, 10_000, 5_000)).toBe(false);
    expect(shouldResetOnFocus(6_000, 10_000, 5_000)).toBe(false);
    expect(shouldResetOnFocus(5_000, 10_000, 5_000)).toBe(true);
  });
});
