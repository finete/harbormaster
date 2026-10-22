/**
 * WebGL parking decision logic for hidden terminal panes (pure, fake timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureWebglContext,
  createWebglParker,
  isContainerVisible,
  WEBGL_PARK_DELAY_MS,
  webglParkDelayMs,
} from "../src/renderer/src/lib/terminal-host/webgl-park";

describe("createWebglParker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(delay = 10_000) {
    const park = vi.fn();
    const unpark = vi.fn();
    const parker = createWebglParker({ park, unpark, delayMs: () => delay });
    return { park, unpark, parker };
  }

  it("parks only after staying hidden for the full delay", () => {
    const { park, parker } = setup();
    parker.setVisible(false);
    vi.advanceTimersByTime(9_999);
    expect(park).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(park).toHaveBeenCalledTimes(1);
    expect(parker.isParked()).toBe(true);
  });

  it("a hide/show flick within the delay never parks or unparks", () => {
    const { park, unpark, parker } = setup();
    parker.setVisible(false);
    vi.advanceTimersByTime(5_000);
    parker.setVisible(true);
    vi.advanceTimersByTime(60_000);
    expect(park).not.toHaveBeenCalled();
    expect(unpark).not.toHaveBeenCalled();
  });

  it("repeated hidden reports do not restart the timer", () => {
    const { park, parker } = setup();
    parker.setVisible(false);
    vi.advanceTimersByTime(6_000);
    parker.setVisible(false);
    vi.advanceTimersByTime(4_000);
    expect(park).toHaveBeenCalledTimes(1);
    parker.setVisible(false);
    vi.advanceTimersByTime(60_000);
    expect(park).toHaveBeenCalledTimes(1);
  });

  it("unparks once when shown after parking, and can park again", () => {
    const { park, unpark, parker } = setup();
    parker.setVisible(false);
    vi.advanceTimersByTime(10_000);
    parker.setVisible(true);
    parker.setVisible(true);
    expect(unpark).toHaveBeenCalledTimes(1);
    expect(parker.isParked()).toBe(false);
    parker.setVisible(false);
    vi.advanceTimersByTime(10_000);
    expect(park).toHaveBeenCalledTimes(2);
  });

  it("visible reports never unpark a pane that was not parked", () => {
    const { unpark, parker } = setup();
    parker.setVisible(true);
    parker.setVisible(true);
    expect(unpark).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending park and ignores later reports", () => {
    const { park, unpark, parker } = setup();
    parker.setVisible(false);
    parker.dispose();
    vi.advanceTimersByTime(60_000);
    expect(park).not.toHaveBeenCalled();
    parker.setVisible(false);
    parker.setVisible(true);
    vi.advanceTimersByTime(60_000);
    expect(park).not.toHaveBeenCalled();
    expect(unpark).not.toHaveBeenCalled();
  });

  it("reads the delay when each hide starts (runtime test knob)", () => {
    let delay = 10_000;
    const park = vi.fn();
    const parker = createWebglParker({
      park,
      unpark: () => {},
      delayMs: () => delay,
    });
    delay = 200;
    parker.setVisible(false);
    vi.advanceTimersByTime(200);
    expect(park).toHaveBeenCalledTimes(1);
  });
});

describe("webglParkDelayMs", () => {
  afterEach(() => {
    delete (globalThis as { __harbormasterWebglParkDelayMs?: unknown })
      .__harbormasterWebglParkDelayMs;
  });

  it("defaults to 10s and honours a numeric global override", () => {
    expect(WEBGL_PARK_DELAY_MS).toBe(10_000);
    expect(webglParkDelayMs()).toBe(10_000);
    (
      globalThis as { __harbormasterWebglParkDelayMs?: unknown }
    ).__harbormasterWebglParkDelayMs = 300;
    expect(webglParkDelayMs()).toBe(300);
    (
      globalThis as { __harbormasterWebglParkDelayMs?: unknown }
    ).__harbormasterWebglParkDelayMs = "nope";
    expect(webglParkDelayMs()).toBe(10_000);
  });
});

describe("isContainerVisible", () => {
  it("requires connection and a non-zero size", () => {
    expect(
      isContainerVisible({
        isConnected: true,
        clientWidth: 10,
        clientHeight: 5,
      }),
    ).toBe(true);
    expect(
      isContainerVisible({
        isConnected: false,
        clientWidth: 10,
        clientHeight: 5,
      }),
    ).toBe(false);
    expect(
      isContainerVisible({
        isConnected: true,
        clientWidth: 0,
        clientHeight: 5,
      }),
    ).toBe(false);
    expect(
      isContainerVisible({
        isConnected: true,
        clientWidth: 10,
        clientHeight: 0,
      }),
    ).toBe(false);
  });
});

describe("captureWebglContext", () => {
  it("loses the addon's GL context via WEBGL_lose_context, once", () => {
    const loseContext = vi.fn();
    let lost = false;
    const gl = {
      getExtension: (name: string) =>
        name === "WEBGL_lose_context"
          ? {
              loseContext: () => {
                lost = true;
                loseContext();
              },
            }
          : null,
      isContextLost: () => lost,
    };
    const ctx = captureWebglContext({ _renderer: { _gl: gl } });
    ctx?.loseContext();
    ctx?.loseContext();
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("tolerates addons without a renderer or throwing internals", () => {
    expect(captureWebglContext({})).toBeUndefined();
    expect(captureWebglContext(undefined)).toBeUndefined();
    const ctx = captureWebglContext({
      _renderer: {
        _gl: {
          getExtension: () => {
            throw new Error("boom");
          },
          isContextLost: () => false,
        },
      },
    });
    expect(() => ctx?.loseContext()).not.toThrow();
  });
});
