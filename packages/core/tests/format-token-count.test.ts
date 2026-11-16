import { describe, expect, it } from "vitest";
import { formatTokenCount } from "../src/index.js";

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [412, "412"],
    [999, "999"],
    [1_000, "1.0k"],
    [1_940, "1.9k"],
    [9_960, "10k"],
    [92_000, "92k"],
    [999_400, "999k"],
    [999_600, "1.0M"],
    [1_900_000, "1.9M"],
    [9_800_000, "9.8M"],
    [10_000_000, "10M"],
    [412_000_000, "412M"],
    [2_500_000_000, "2.5B"],
    [-92_000, "-92k"],
    [Number.NaN, "0"],
  ])("%d → %s", (n, text) => {
    expect(formatTokenCount(n)).toBe(text);
  });
});
