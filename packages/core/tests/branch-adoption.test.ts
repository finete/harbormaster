import { describe, expect, it } from "vitest";
import { branchToAdopt } from "../src/engines/branch-adoption.js";

const base = {
  taskBranch: "task/a",
  currentBranch: "task/a",
  targetBranch: "main",
  defaultBranch: "main",
};

describe("branchToAdopt", () => {
  it("keeps the same branch", () => {
    expect(branchToAdopt(base)).toBeUndefined();
  });
  it("ignores detached/unreadable", () => {
    expect(
      branchToAdopt({ ...base, currentBranch: undefined }),
    ).toBeUndefined();
    expect(branchToAdopt({ ...base, currentBranch: "" })).toBeUndefined();
  });
  it("never adopts the target branch", () => {
    expect(
      branchToAdopt({
        ...base,
        currentBranch: "release",
        targetBranch: "release",
      }),
    ).toBeUndefined();
  });
  it("never adopts the default branch", () => {
    expect(branchToAdopt({ ...base, currentBranch: "main" })).toBeUndefined();
    expect(
      branchToAdopt({
        ...base,
        currentBranch: "trunk",
        targetBranch: "release",
        defaultBranch: "trunk",
      }),
    ).toBeUndefined();
  });
  it("adopts a real new branch", () => {
    expect(branchToAdopt({ ...base, currentBranch: "other" })).toBe("other");
  });
});
