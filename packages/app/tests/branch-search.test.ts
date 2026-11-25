// The base-branch picker's search (renderer/src/lib/branch-search.ts; see
// docs/new-task-composer.md "Base branch").
import { describe, expect, it } from "vitest";
import {
  BRANCH_RESULT_LIMIT,
  branchMatches,
  matchBranches,
} from "../src/renderer/src/lib/branch-search";

describe("matchBranches", () => {
  it("with no query, keeps git's order and caps the list, counting the rest", () => {
    const branches = Array.from({ length: 120 }, (_, i) => `b-${i}`);
    const { shown, hidden } = matchBranches(branches, "  ");
    expect(shown).toEqual(branches.slice(0, BRANCH_RESULT_LIMIT));
    expect(hidden).toBe(120 - BRANCH_RESULT_LIMIT);
    expect(matchBranches(["a", "b"], "")).toEqual({
      shown: ["a", "b"],
      hidden: 0,
    });
  });

  it("ranks an exact name, then a prefix or path-segment prefix, then a substring; ties keep input order", () => {
    const branches = [
      "feature/old-login-fix",
      "origin/login",
      "login-page",
      "origin/feature/login-redo",
      "login",
    ];
    expect(matchBranches(branches, "LOGIN").shown).toEqual([
      "origin/login",
      "login",
      "login-page",
      "origin/feature/login-redo",
      "feature/old-login-fix",
    ]);
  });

  it("requires every word, in any order", () => {
    const branches = ["sergey/fix-wallet-sync", "sergey/wallet-ui", "fix-sync"];
    expect(matchBranches(branches, "sync sergey").shown).toEqual([
      "sergey/fix-wallet-sync",
    ]);
    expect(matchBranches(branches, "nothing").shown).toEqual([]);
  });

  it("finds a match past the cap and counts only matches as hidden", () => {
    const branches = [
      ...Array.from({ length: 9000 }, (_, i) => `origin/topic-${i}`),
      "origin/very-old-branch",
    ];
    expect(matchBranches(branches, "very-old").shown).toEqual([
      "origin/very-old-branch",
    ]);
    const topics = matchBranches(branches, "topic-1");
    expect(topics.shown).toHaveLength(BRANCH_RESULT_LIMIT);
    expect(topics.shown[0]).toBe("origin/topic-1");
    // topic-1, topic-1x (10), topic-1xx (100), topic-1xxx (1000).
    expect(topics.hidden).toBe(1111 - BRANCH_RESULT_LIMIT);
  });

  it("stays fast on a repository with tens of thousands of branches", () => {
    const branches = Array.from(
      { length: 50_000 },
      (_, i) => `origin/user-${i % 97}/ticket-${i}-some-description`,
    );
    const start = performance.now();
    for (const query of ["t", "ti", "tic", "ticket-4", "user-3 ticket-49"]) {
      matchBranches(branches, query);
    }
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("branchMatches", () => {
  it("matches every word case-insensitively; an empty query matches all", () => {
    expect(branchMatches("main", "")).toBe(true);
    expect(branchMatches("main", "MA")).toBe(true);
    expect(branchMatches("origin/main", "orig main")).toBe(true);
    expect(branchMatches("main", "dev")).toBe(false);
  });
});
