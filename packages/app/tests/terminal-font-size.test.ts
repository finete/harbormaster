// The renderer's `terminal.fontSize` store (lib/terminal-font-size.ts):
// read through core's getSettings, re-read on config-changed for terminal.*
// keys only, and pushed to subscribed panes.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  affectsTerminalFontSize,
  toTerminalFontSize,
} from "../src/renderer/src/lib/terminal-font-size";

describe("terminal font size", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("matches only terminal keys and usable sizes", () => {
    expect(affectsTerminalFontSize(["terminal.fontSize"])).toBe(true);
    expect(affectsTerminalFontSize(["codeRoot", "terminal"])).toBe(true);
    expect(affectsTerminalFontSize(["terminalish", "codeRoot"])).toBe(false);
    expect(toTerminalFontSize(15)).toBe(15);
    expect(toTerminalFontSize(null)).toBeUndefined();
    expect(toTerminalFontSize(0)).toBeUndefined();
  });

  it("loads the setting, then follows config changes that touch it", async () => {
    let size = 16;
    let configListener:
      | ((payload: { changedKeys: string[] }) => void)
      | undefined;
    const getSettings = vi.fn(async () => ({
      values: { "terminal.fontSize": size },
    }));
    vi.stubGlobal("window", {
      harbormaster: {
        core: {
          getSettings,
          onConfigChanged: (
            listener: (payload: { changedKeys: string[] }) => void,
          ) => {
            configListener = listener;
            return () => {};
          },
        },
      },
    });
    const store = await import("../src/renderer/src/lib/terminal-font-size");
    expect(store.terminalFontSize()).toBe(13);
    const seen: number[] = [];
    store.onTerminalFontSizeChange((next) => seen.push(next));
    await vi.waitFor(() => expect(seen).toEqual([16]));
    expect(store.terminalFontSize()).toBe(16);

    size = 20;
    configListener?.({ changedKeys: ["automation"] });
    configListener?.({ changedKeys: ["terminal.fontSize"] });
    await vi.waitFor(() => expect(seen).toEqual([16, 20]));
    // Only the terminal change re-read (plus the initial read).
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});
