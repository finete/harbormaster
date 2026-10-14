import { describe, expect, it } from "vitest";
import { repositoryLabel } from "../src/renderer/src/lib/repository-label";

describe("repositoryLabel", () => {
  it("renders the plain repository id for a single checkout", () => {
    expect(
      repositoryLabel({
        id: "github.com/arnac-io/arnac",
        checkouts: [{ root: "/Code/arnac", isPrimary: true }],
      }),
    ).toBe("github.com/arnac-io/arnac");
  });

  it("appends a checkout count when there is more than one checkout", () => {
    expect(
      repositoryLabel({
        id: "github.com/arnac-io/arnac",
        checkouts: [
          { root: "/Code/arnac", isPrimary: true },
          { root: "/Code/arnac2", isPrimary: false },
          { root: "/Code/arnac3", isPrimary: false },
        ],
      }),
    ).toBe("github.com/arnac-io/arnac — 3 checkouts");
  });

  it("renders singular phrasing correctly (never '1 checkouts')", () => {
    expect(
      repositoryLabel({
        id: "/Code/solo",
        checkouts: [{ root: "/Code/solo", isPrimary: true }],
      }),
    ).toBe("/Code/solo");
  });
});
