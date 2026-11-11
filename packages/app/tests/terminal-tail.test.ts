import { describe, expect, it } from "vitest";
import { bufferTail } from "../src/shared/terminal-tail";

function buffer(lines: string[]) {
  return {
    length: lines.length,
    getLine: (index: number) =>
      index < lines.length
        ? { translateToString: () => lines[index] ?? "" }
        : undefined,
  };
}

describe("bufferTail", () => {
  it("keeps the last lines with content, dropping trailing blank rows", () => {
    expect(bufferTail(buffer(["a", "b", "c", "", "  "]), 2)).toBe("b\nc");
    expect(bufferTail(buffer(["a", "", "b"]), 30)).toBe("a\n\nb");
    expect(bufferTail(buffer(["", ""]), 5)).toBe("");
  });
});
