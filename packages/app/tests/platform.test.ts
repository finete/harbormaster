import { describe, expect, it } from "vitest";
import { isMacPlatform, modKeyLabel } from "../src/renderer/src/lib/platform";

describe("platform helper", () => {
  it("detects macOS platform strings", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("Macintosh")).toBe(true);
  });

  it("detects non-mac platform strings", () => {
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });

  it("labels the modifier key per platform", () => {
    expect(modKeyLabel("MacIntel")).toBe("⌘");
    expect(modKeyLabel("Win32")).toBe("Ctrl+");
    expect(modKeyLabel("Linux x86_64")).toBe("Ctrl+");
  });
});
