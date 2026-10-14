import { describe, expect, it } from "vitest";
import type { RepositoryInfo } from "../src/contracts/workspace.js";
import { repositoryLabel } from "../src/engines/repository-label.js";

function repo(overrides: Partial<RepositoryInfo>): RepositoryInfo {
  return {
    id: "github.com/arnac-io/arnac",
    root: "/Code/arnac",
    defaultBranch: "main",
    checkouts: [{ root: "/Code/arnac", isPrimary: true }],
    ...overrides,
  };
}

describe("repositoryLabel", () => {
  it("is the plain repository id when there is exactly one checkout", () => {
    expect(repositoryLabel(repo({}))).toBe("github.com/arnac-io/arnac");
  });

  it("appends a checkout count when there are several checkouts (arnac/arnac2/arnac3)", () => {
    expect(
      repositoryLabel(
        repo({
          checkouts: [
            { root: "/Code/arnac", isPrimary: true },
            { root: "/Code/arnac2", isPrimary: false },
            { root: "/Code/arnac3", isPrimary: false },
          ],
        }),
      ),
    ).toBe("github.com/arnac-io/arnac — 3 checkouts");
  });
});
