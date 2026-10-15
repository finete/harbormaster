import { describe, expect, it } from "vitest";
import { parseDeployedVersion } from "../src/engines/deployment.js";

describe("parseDeployedVersion format tolerance", () => {
  it("parses classic semver documents", () => {
    const v = parseDeployedVersion("v0.115.20+ca9bdff2");
    expect([v.major, v.minor, v.patch, v.commitOid]).toEqual([
      0,
      115,
      20,
      "ca9bdff2",
    ]);
  });
  it("parses calendar/CI versions with four segments (Fordefi format)", () => {
    const v = parseDeployedVersion("2026.10.15.019+0075f431");
    expect([v.major, v.minor, v.patch]).toEqual([2026, 10, 15]);
    expect(v.commitOid).toBe("0075f431");
  });
  it("parses two-segment versions", () => {
    expect(parseDeployedVersion("12.5+abcdef012").commitOid).toBe("abcdef012");
  });
  it("still rejects documents without a commit suffix", () => {
    expect(() => parseDeployedVersion("2026.10.15.019")).toThrow(
      /Unrecognized/,
    );
  });
});
