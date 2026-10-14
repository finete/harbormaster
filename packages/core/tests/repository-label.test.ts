import { describe, expect, it } from "vitest";
import type { RepositoryInfo } from "../src/contracts/workspace.js";
import { repositoryLabel } from "../src/engines/repository-label.js";

function repo(overrides: Partial<RepositoryInfo>): RepositoryInfo {
  return {
    id: "github.com/acme/widgets",
    root: "/Code/widgets",
    defaultBranch: "main",
    checkouts: [{ root: "/Code/widgets", isPrimary: true }],
    ...overrides,
  };
}

describe("repositoryLabel", () => {
  it("is the plain repository id when there is exactly one checkout", () => {
    expect(repositoryLabel(repo({}))).toBe("github.com/acme/widgets");
  });

  it("appends a checkout count when there are several checkouts (widgets/widgets2/widgets3)", () => {
    expect(
      repositoryLabel(
        repo({
          checkouts: [
            { root: "/Code/widgets", isPrimary: true },
            { root: "/Code/widgets2", isPrimary: false },
            { root: "/Code/widgets3", isPrimary: false },
          ],
        }),
      ),
    ).toBe("github.com/acme/widgets — 3 checkouts");
  });
});
