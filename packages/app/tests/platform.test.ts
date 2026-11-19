import { describe, expect, it } from "vitest";
import {
  boardShortcutLabel,
  isMacPlatform,
  modKeyLabel,
  sidebarShortcutLabel,
} from "../src/renderer/src/lib/platform";

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

  it("labels the sidebar (Cmd+B) and board (Cmd+Shift+B) shortcuts", () => {
    expect(sidebarShortcutLabel("MacIntel")).toBe("⌘B");
    expect(sidebarShortcutLabel("Win32")).toBe("Ctrl+B");
    expect(boardShortcutLabel("MacIntel")).toBe("⌘⇧B");
    expect(boardShortcutLabel("Linux x86_64")).toBe("Ctrl+Shift+B");
  });
});
