import { describe, expect, it } from "vitest";
import { repoColorClass } from "../src/renderer/src/lib/repo-color";

describe("repoColorClass", () => {
  it("is deterministic per label", () => {
    expect(repoColorClass("arnac")).toBe(repoColorClass("arnac"));
  });
  it("returns a tailwind text class", () => {
    expect(repoColorClass("arnac")).toMatch(/^text-/);
  });
  it("spreads different labels across the palette", () => {
    const labels = [
      "arnac",
      "bi",
      "fordicode",
      "pi-home",
      "harbormaster",
      "fordecode",
    ];
    const classes = new Set(labels.map(repoColorClass));
    expect(classes.size).toBeGreaterThan(2);
  });
});
