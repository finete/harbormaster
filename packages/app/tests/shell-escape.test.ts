import { describe, expect, it } from "vitest";
import { shellEscapePath, shellEscapePaths } from "../src/shared/shell-escape";

describe("shellEscapePath", () => {
  it("escapes spaces in paths", () => {
    expect(shellEscapePath("/a b/c.png")).toBe("/a\\ b/c.png");
  });

  it("escapes parentheses (cmux parity)", () => {
    expect(shellEscapePath("/a b/c(1).png")).toBe("/a\\ b/c\\(1\\).png");
  });

  it("escapes single quotes", () => {
    expect(shellEscapePath("it's")).toBe("it\\'s");
  });

  it("single-quotes strings with embedded newlines", () => {
    expect(shellEscapePath("a\nb")).toBe("'a\nb'");
  });

  it("escapes $ (dollar sign)", () => {
    expect(shellEscapePath("$HOME")).toBe("\\$HOME");
  });

  it("strips control characters (NUL, BS, etc.)", () => {
    // U+0007 = BEL, U+0001 = SOH — should be stripped
    expect(shellEscapePath("hel\x07lo\x01")).toBe("hello");
  });

  it("keeps TAB (escapes it as shell special)", () => {
    expect(shellEscapePath("a\tb")).toBe("a\\\tb");
  });

  it("keeps LF (wraps in single quotes)", () => {
    const result = shellEscapePath("line1\nline2");
    expect(result).toBe("'line1\nline2'");
  });

  it("escapes backslash", () => {
    expect(shellEscapePath("a\\b")).toBe("a\\\\b");
  });

  it("escapes special chars: ()[]{}|&;", () => {
    expect(shellEscapePath("a|b;c&d")).toBe("a\\|b\\;c\\&d");
  });

  it("escapes asterisk and question mark", () => {
    expect(shellEscapePath("*.txt?")).toBe("\\*.txt\\?");
  });

  it("handles a plain path with no special chars", () => {
    expect(shellEscapePath("/usr/local/bin/sh")).toBe("/usr/local/bin/sh");
  });
});

describe("shellEscapePaths", () => {
  it("joins multiple escaped paths with a single space (no trailing space)", () => {
    expect(shellEscapePaths(["/a b.png", "/c.txt"])).toBe("/a\\ b.png /c.txt");
  });

  it("handles a single path", () => {
    expect(shellEscapePaths(["/home/user/file.txt"])).toBe(
      "/home/user/file.txt",
    );
  });

  it("returns empty string for an empty array", () => {
    expect(shellEscapePaths([])).toBe("");
  });
});
