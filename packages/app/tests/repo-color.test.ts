import { describe, expect, it } from "vitest";
import { repoColorClass } from "../src/renderer/src/lib/repo-color";

describe("repoColorClass", () => {
  it("is the uniform brand mint for every label", () => {
    for (const label of ["arnac", "bi", "fordicode", "harbormaster"]) {
      expect(repoColorClass(label)).toBe("text-primary");
    }
  });
});
