import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedClis } from "./pinned-clis.mjs";

describe("pinnedClis", () => {
  it("reads the PINNED block of the real-CLI smoke test", () => {
    const source = readFileSync(
      join(__dirname, "..", "packages/app/tests/real-cli-smoke.test.ts"),
      "utf8",
    );
    const specs = pinnedClis(source);
    expect(specs.length).toBeGreaterThanOrEqual(2);
    for (const spec of specs) expect(spec).toMatch(/^@?[\w./-]+@\d[\w.-]*$/);
  });

  it("sorts the specs and rejects a file without pins", () => {
    expect(
      pinnedClis(
        'export const PINNED = {\n  z: "z-cli@2.0.0",\n  a: "@s/a@1.2.3",\n} as const;',
      ),
    ).toEqual(["@s/a@1.2.3", "z-cli@2.0.0"]);
    expect(() => pinnedClis("const x = 1;")).toThrow(/PINNED/);
  });
});
