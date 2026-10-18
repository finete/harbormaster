import { describe, expect, it } from "vitest";
import { dropInsertText } from "../src/renderer/src/lib/terminal-host/drop";

describe("dropInsertText", () => {
  it("shell-escapes and joins multiple paths with a space", () => {
    expect(dropInsertText(["/a b.png", "/c.txt"], null)).toBe(
      "/a\\ b.png /c.txt",
    );
  });

  it("returns the first non-comment uri-list line when paths is empty", () => {
    const uriList =
      "# comment\nhttps://example.com/file.txt\nhttps://other.com";
    expect(dropInsertText([], uriList)).toBe("https://example.com/file.txt");
  });

  it("returns null when paths is empty and uriList is null", () => {
    expect(dropInsertText([], null)).toBeNull();
  });

  it("returns null when paths is empty and uriList is only comments", () => {
    expect(dropInsertText([], "# only a comment")).toBeNull();
  });

  it("paths win over uri-list", () => {
    expect(dropInsertText(["/real/path.txt"], "http://ignored.com")).toBe(
      "/real/path.txt",
    );
  });

  it("escapes special characters in paths", () => {
    expect(dropInsertText(["/my files/doc (1).txt"], null)).toBe(
      "/my\\ files/doc\\ \\(1\\).txt",
    );
  });
});
