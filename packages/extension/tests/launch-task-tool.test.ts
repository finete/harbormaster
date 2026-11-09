import type { RepositoryInfo } from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import {
  buildLaunchResultText,
  launchRepositoryLabel,
  looksLikeCloneUrl,
  repositoryShortName,
  resolveLaunchRepository,
} from "../src/launch-task-tool.js";

function repo(id: string): RepositoryInfo {
  return {
    id,
    root: `/code/${repositoryShortName(id)}`,
    defaultBranch: "main",
    checkouts: [{ root: `/code/${repositoryShortName(id)}`, isPrimary: true }],
  };
}

describe("looksLikeCloneUrl", () => {
  it("recognizes https/ssh/git URLs", () => {
    expect(looksLikeCloneUrl("https://github.com/org/repo")).toBe(true);
    expect(looksLikeCloneUrl("ssh://git@github.com/org/repo.git")).toBe(true);
    expect(looksLikeCloneUrl("git@github.com:org/repo.git")).toBe(true);
  });
  it("rejects plain repository ids and short names", () => {
    expect(looksLikeCloneUrl("github.com/org/repo")).toBe(false);
    expect(looksLikeCloneUrl("repo")).toBe(false);
    expect(looksLikeCloneUrl("none")).toBe(false);
  });
});

describe("resolveLaunchRepository", () => {
  const repos = [
    repo("github.com/org/arnac"),
    repo("github.com/other/widgets"),
  ];

  it('resolves "none" (case-insensitive) to no repository', () => {
    expect(resolveLaunchRepository("none", repos)).toEqual({ none: true });
    expect(resolveLaunchRepository("None", repos)).toEqual({ none: true });
    expect(resolveLaunchRepository("  NONE  ", repos)).toEqual({ none: true });
  });

  it("resolves a clone URL straight through, without matching repos", () => {
    expect(
      resolveLaunchRepository("https://github.com/org/new-repo", repos),
    ).toEqual({ cloneUrl: "https://github.com/org/new-repo" });
  });

  it("resolves an exact repository id", () => {
    expect(resolveLaunchRepository("github.com/org/arnac", repos)).toEqual({
      repositoryId: "github.com/org/arnac",
    });
  });

  it("resolves registered folders by path or unique name, and absolute paths as folders", () => {
    const locations = [
      { path: "/Users/me/notes", name: "notes" },
      {
        path: "/Users/me/side",
        name: "side",
        repositoryId: "github.com/o/side",
      },
    ];
    expect(resolveLaunchRepository("notes", repos, locations)).toEqual({
      folderPath: "/Users/me/notes",
    });
    expect(
      resolveLaunchRepository("/Users/me/notes", repos, locations),
    ).toEqual({ folderPath: "/Users/me/notes" });
    expect(resolveLaunchRepository("/tmp/elsewhere", repos, locations)).toEqual(
      { folderPath: "/tmp/elsewhere" },
    );
    // A git folder is a repository (listRepositories has it), never a folder by name.
    expect(() => resolveLaunchRepository("side", repos, locations)).toThrow(
      /Unknown repository/,
    );
  });

  it("resolves a unique short name", () => {
    expect(resolveLaunchRepository("arnac", repos)).toEqual({
      repositoryId: "github.com/org/arnac",
    });
  });

  it("rejects an ambiguous short name, listing candidates", () => {
    const ambiguous = [
      repo("github.com/org-a/widgets"),
      repo("github.com/org-b/widgets"),
    ];
    expect(() => resolveLaunchRepository("widgets", ambiguous)).toThrow(
      /Ambiguous repository "widgets".*org-a\/widgets.*org-b\/widgets/s,
    );
  });

  it("rejects an unknown repository, listing known candidates", () => {
    expect(() => resolveLaunchRepository("nope", repos)).toThrow(
      /Unknown repository "nope".*github\.com\/org\/arnac/s,
    );
  });

  it("rejects an unknown repository with no candidates discovered", () => {
    expect(() => resolveLaunchRepository("nope", [])).toThrow(
      /Unknown repository "nope"\. No repositories are discovered/,
    );
  });

  it("rejects an empty repository string", () => {
    expect(() => resolveLaunchRepository("   ", repos)).toThrow(
      /repository is required/,
    );
  });
});

describe("launchRepositoryLabel", () => {
  it("labels each repository variant", () => {
    expect(launchRepositoryLabel({ none: true })).toBe("no repository");
    expect(launchRepositoryLabel({ cloneUrl: "https://x/y" })).toBe(
      "https://x/y",
    );
    expect(launchRepositoryLabel({ repositoryId: "github.com/org/repo" })).toBe(
      "github.com/org/repo",
    );
  });
});

describe("buildLaunchResultText", () => {
  it("states the title, id, relation, repository, and QUEUED status", () => {
    const text = buildLaunchResultText({
      title: "Fix the bug",
      id: "task-2",
      relation: "standalone",
      repositoryLabel: "github.com/org/repo",
    });
    expect(text).toContain('"Fix the bug" (task-2)');
    expect(text).toContain("standalone task in github.com/org/repo");
    expect(text).toContain("QUEUED");
    expect(text).not.toContain("harbormaster_subtask_status");
  });

  it("mentions harbormaster_subtask_status for a child launch", () => {
    const text = buildLaunchResultText({
      title: "Fix the bug",
      id: "task-2",
      relation: "child",
      repositoryLabel: "no repository",
    });
    expect(text).toContain("harbormaster_subtask_status");
  });
});
