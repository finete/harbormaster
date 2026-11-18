import { describe, expect, it } from "vitest";
import type {
  CoreCommands,
  LaunchTaskInput,
} from "../src/contracts/commands.js";
import type { RepositoryInfo } from "../src/contracts/workspace.js";
import { dispatchToolCall } from "../src/tools/catalog.js";
import {
  buildLaunchResultText,
  launchRepositoryLabel,
  looksLikeCloneUrl,
  pullRequestMention,
  repositoryShortName,
  resolveLaunchMode,
  resolveLaunchRepository,
} from "../src/tools/launch-repository.js";

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
    repo("github.com/org/gadgets"),
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
    expect(resolveLaunchRepository("github.com/org/gadgets", repos)).toEqual({
      repositoryId: "github.com/org/gadgets",
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
    expect(resolveLaunchRepository("gadgets", repos)).toEqual({
      repositoryId: "github.com/org/gadgets",
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
      /Unknown repository "nope".*github\.com\/org\/gadgets/s,
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
    expect(text).not.toContain("subtask_status");
  });

  it("mentions subtask_status for a child launch", () => {
    const text = buildLaunchResultText({
      title: "Fix the bug",
      id: "task-2",
      relation: "child",
      repositoryLabel: "no repository",
    });
    expect(text).toContain("subtask_status");
  });
});

describe("resolveLaunchMode", () => {
  it("task by default; chat runs in place", () => {
    expect(resolveLaunchMode({ repository: "widgets" })).toEqual({
      repository: "widgets",
    });
    expect(resolveLaunchMode({ mode: "chat", repository: "widgets" })).toEqual({
      repository: "widgets",
      inPlace: true,
    });
  });

  it("review takes a PR URL (supplying the repository) or a number with repository; role from GitHub unless given", () => {
    expect(
      resolveLaunchMode({
        mode: "review",
        pullRequest: "https://github.com/Acme/Widgets/pull/12",
      }),
    ).toEqual({ repository: "github.com/acme/widgets", pullRequest: 12 });
    expect(
      resolveLaunchMode({
        mode: "review",
        repository: "widgets",
        pullRequest: "#12",
        role: "reviewer",
      }),
    ).toEqual({ repository: "widgets", pullRequest: 12, role: "reviewer" });
  });

  it("task with a PR continues it as author", () => {
    expect(
      resolveLaunchMode({
        pullRequest: "https://github.com/acme/widgets/pull/3",
      }),
    ).toEqual({
      repository: "github.com/acme/widgets",
      pullRequest: 3,
      role: "author",
    });
  });

  it("rejects contradictions readably", () => {
    expect(() =>
      resolveLaunchMode({ mode: "review", repository: "w" }),
    ).toThrow(/needs pullRequest/);
    expect(() =>
      resolveLaunchMode({ mode: "chat", repository: "w", pullRequest: "1" }),
    ).toThrow(/takes no pullRequest/);
    expect(() =>
      resolveLaunchMode({ mode: "review", pullRequest: "12" }),
    ).toThrow(/needs repository/);
    expect(() =>
      resolveLaunchMode({ repository: "w", pullRequest: "main" }),
    ).toThrow(/PR URL .* or number/);
    expect(() =>
      resolveLaunchMode({ repository: "w", role: "author" }),
    ).toThrow(/role only applies/);
    expect(() => resolveLaunchMode({})).toThrow(/repository is required/);
  });
});

describe("pullRequestMention", () => {
  it("finds a PR URL anywhere, or a numbered PR next to the word review", () => {
    expect(
      pullRequestMention(
        "Test review",
        "Look at https://github.com/arnac-io/arnac/pull/26873 please",
      ),
    ).toBe("https://github.com/arnac-io/arnac/pull/26873");
    expect(pullRequestMention("Review PR #26873", "go")).toBe("#26873");
    expect(pullRequestMention("CR", "please review pull request 12")).toBe(
      "#12",
    );
    expect(pullRequestMention("Fix PR #12 flake", "no reviewing")).toBe("#12");
    expect(pullRequestMention("Fix the build", "PR #12 broke it")).toBe(
      undefined,
    );
    expect(pullRequestMention("Fix the build", "just do it")).toBe(undefined);
  });
});

describe("launch_task / review_pull_request (tool calls)", () => {
  function fakeCommands(launched: LaunchTaskInput[]): CoreCommands {
    return {
      listRepositories: async () => [repo("github.com/arnac-io/arnac")],
      listLocations: async () => [],
      launchTask: async (input: LaunchTaskInput) => {
        launched.push(input);
        return { id: "t-1", title: input.title };
      },
    } as unknown as CoreCommands;
  }
  const caller = { taskId: "parent-1", cwd: "/tmp" };

  it("refuses a launch_task that names a PR without pullRequest, pointing at review_pull_request", async () => {
    const launched: LaunchTaskInput[] = [];
    await expect(
      dispatchToolCall(
        fakeCommands(launched),
        "launch_task",
        {
          relation: "child",
          title: "Test review PR #26873",
          prompt: "Review https://github.com/arnac-io/arnac/pull/26873",
          repository: "github.com/arnac-io/arnac",
        },
        caller,
      ),
    ).rejects.toThrow(
      /review_pull_request \(pullRequest: "https:\/\/github\.com\/arnac-io\/arnac\/pull\/26873"\)/,
    );
    expect(launched).toEqual([]);

    // "none" confirms new work that only mentions the PR.
    await dispatchToolCall(
      fakeCommands(launched),
      "launch_task",
      {
        relation: "child",
        title: "Follow-up to PR #26873",
        prompt:
          "Review notes from https://github.com/arnac-io/arnac/pull/26873 call for a new helper",
        repository: "github.com/arnac-io/arnac",
        pullRequest: "none",
      },
      caller,
    );
    expect(launched[0]?.pullRequest).toBeUndefined();
  });

  it("review_pull_request launches a review child on the PR, titled after it", async () => {
    const launched: LaunchTaskInput[] = [];
    await dispatchToolCall(
      fakeCommands(launched),
      "review_pull_request",
      {
        pullRequest: "https://github.com/arnac-io/arnac/pull/26873",
        prompt: "Review only this PR's own diff.",
      },
      caller,
    );
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      relation: "child",
      fromTaskId: "parent-1",
      title: "Review PR #26873",
      repository: { repositoryId: "github.com/arnac-io/arnac" },
      pullRequest: 26873,
    });
  });
});
