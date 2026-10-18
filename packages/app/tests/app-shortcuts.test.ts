import { describe, expect, it } from "vitest";
import {
  type InputEvent,
  isCloseTabChord,
  isSidebarCycleChord,
} from "../src/main/app-shortcuts";

function input(overrides: Partial<InputEvent>): InputEvent {
  return {
    type: "keyDown",
    key: "w",
    meta: false,
    control: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

describe("isCloseTabChord", () => {
  describe("darwin", () => {
    it("Cmd+W is the close-tab chord", () => {
      expect(isCloseTabChord(input({ meta: true, key: "w" }), "darwin")).toBe(
        true,
      );
    });

    it("Ctrl+W is NOT the close-tab chord (must reach pty)", () => {
      expect(
        isCloseTabChord(input({ control: true, key: "w" }), "darwin"),
      ).toBe(false);
    });

    it("Cmd+Ctrl+W is not the close-tab chord", () => {
      expect(
        isCloseTabChord(
          input({ meta: true, control: true, key: "w" }),
          "darwin",
        ),
      ).toBe(false);
    });

    it("Cmd+Shift+W is not the close-tab chord", () => {
      expect(
        isCloseTabChord(input({ meta: true, shift: true, key: "w" }), "darwin"),
      ).toBe(false);
    });

    it("keyUp event is not the close-tab chord", () => {
      expect(
        isCloseTabChord(
          input({ meta: true, key: "w", type: "keyUp" }),
          "darwin",
        ),
      ).toBe(false);
    });
  });

  describe("linux", () => {
    it("Ctrl+W is the close-tab chord", () => {
      expect(isCloseTabChord(input({ control: true, key: "w" }), "linux")).toBe(
        true,
      );
    });

    it("Cmd+W is not the close-tab chord on linux", () => {
      expect(isCloseTabChord(input({ meta: true, key: "w" }), "linux")).toBe(
        false,
      );
    });
  });
});

describe("isSidebarCycleChord", () => {
  describe("darwin", () => {
    it("Cmd+Shift+Up is the sidebar cycle chord", () => {
      expect(
        isSidebarCycleChord(
          input({ meta: true, shift: true, key: "ArrowUp" }),
          "darwin",
        ),
      ).toBe(true);
    });

    it("Cmd+Shift+Down is the sidebar cycle chord", () => {
      expect(
        isSidebarCycleChord(
          input({ meta: true, shift: true, key: "ArrowDown" }),
          "darwin",
        ),
      ).toBe(true);
    });

    it("Ctrl+Shift+Up is NOT the sidebar cycle chord on darwin", () => {
      expect(
        isSidebarCycleChord(
          input({ control: true, shift: true, key: "ArrowUp" }),
          "darwin",
        ),
      ).toBe(false);
    });
  });

  describe("linux", () => {
    it("Ctrl+Shift+Up is the sidebar cycle chord on linux", () => {
      expect(
        isSidebarCycleChord(
          input({ control: true, shift: true, key: "ArrowUp" }),
          "linux",
        ),
      ).toBe(true);
    });
  });
});
