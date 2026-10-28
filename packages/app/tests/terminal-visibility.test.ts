import { describe, expect, it } from "vitest";
import { isContainerVisible } from "../src/renderer/src/lib/terminal-host/visibility";

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
