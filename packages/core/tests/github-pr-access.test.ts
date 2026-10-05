// Ported and adapted from pi-home's tests/integration/github-pr-access.test.ts
// for Harbormaster's normalized-repository-id model (no RepositoryRef/remote
// lookup — `apiPath` derives "owner/repo" straight from the id). `gh`/`git`
// are always faked: this test never touches a network or a real remote.

import { describe, expect, it, vi } from "vitest";
import { GithubPrAccess } from "../src/access/github-pr-access.js";

const repositoryId = "github.com/acme/widgets";

describe("GithubPrAccess fixtures", () => {
  it("maps requested/submitted review and current-head changes metadata", async () => {
    const execute = vi.fn(async (_command: string, _args: string[]) =>
      JSON.stringify([
        {
          number: 12,
          url: "https://github/pr/12",
          state: "OPEN",
          headRefOid: "head",
          reviewDecision: "CHANGES_REQUESTED",
          reviewRequests: [{ login: "r" }],
          reviews: [{ state: "CHANGES_REQUESTED", commit: { oid: "head" } }],
        },
      ]),
    );
    const status = await new GithubPrAccess(execute).status(
      repositoryId,
      "feature",
    );
    expect(status).toMatchObject({
      number: 12,
      state: "OPEN",
      reviewRequested: true,
      reviewSubmitted: true,
      reviewDecision: "CHANGES_REQUESTED",
      changesRequestedOnHead: true,
    });
    expect(execute.mock.calls[0]?.[1]).toContain("feature");
    expect(execute.mock.calls[0]?.[1].at(-1)).toContain("headRefOid");
  });

  it("marks a changes-requested review on an older commit as stale", async () => {
    const execute = vi.fn(async () =>
      JSON.stringify([
        {
          number: 13,
          url: "https://github/pr/13",
          state: "OPEN",
          headRefOid: "new-head",
          reviewDecision: "CHANGES_REQUESTED",
          reviews: [
            { state: "CHANGES_REQUESTED", commit: { oid: "old-head" } },
          ],
        },
      ]),
    );
    const status = await new GithubPrAccess(execute).status(
      repositoryId,
      "feature",
    );
    expect(status).toMatchObject({
      reviewDecision: "CHANGES_REQUESTED",
      changesRequestedOnHead: false,
      humanFeedbackOnHead: false,
    });
  });

  it("flags a human COMMENTED review on the current head but ignores bot and stale reviews", async () => {
    const reviews = (list: unknown[]) =>
      vi.fn(async () =>
        JSON.stringify([
          {
            number: 20,
            url: "https://github/pr/20",
            state: "OPEN",
            headRefOid: "head",
            reviewDecision: "REVIEW_REQUIRED",
            author: { login: "alice" },
            reviews: list,
          },
        ]),
      );
    const human = {
      state: "COMMENTED",
      commit: { oid: "head" },
      author: { login: "bob" },
      authorAssociation: "MEMBER",
    };
    const app = {
      state: "COMMENTED",
      commit: { oid: "head" },
      author: { login: "claude" },
      authorAssociation: "NONE",
    };
    const bot = {
      state: "COMMENTED",
      commit: { oid: "head" },
      author: { login: "linter[bot]" },
      authorAssociation: "MEMBER",
    };
    const stale = {
      state: "COMMENTED",
      commit: { oid: "old-head" },
      author: { login: "bob" },
      authorAssociation: "MEMBER",
    };
    const self = {
      state: "COMMENTED",
      commit: { oid: "head" },
      author: { login: "alice" },
      authorAssociation: "MEMBER",
    };
    expect(
      await new GithubPrAccess(reviews([app, human])).status(repositoryId, "b"),
    ).toMatchObject({ humanFeedbackOnHead: true });
    expect(
      await new GithubPrAccess(reviews([app, bot])).status(repositoryId, "b"),
    ).toMatchObject({ humanFeedbackOnHead: false });
    expect(
      await new GithubPrAccess(reviews([stale])).status(repositoryId, "b"),
    ).toMatchObject({ humanFeedbackOnHead: false });
    expect(
      await new GithubPrAccess(reviews([self])).status(repositoryId, "b"),
    ).toMatchObject({ humanFeedbackOnHead: false });
    expect(
      await new GithubPrAccess(reviews([self, human])).status(
        repositoryId,
        "b",
      ),
    ).toMatchObject({ humanFeedbackOnHead: true });
  });

  it("returns undefined without a matching PR", async () => {
    expect(
      await new GithubPrAccess(async () => "[]").status(repositoryId, "branch"),
    ).toBeUndefined();
  });

  it("pushes the branch and creates a PR when no open PR exists", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    let listCount = 0;
    const execute = vi.fn(
      async (command: string, args: string[], cwd?: string) => {
        calls.push({ command, args, ...(cwd ? { cwd } : {}) });
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          listCount++;
          return listCount === 1
            ? "[]"
            : JSON.stringify([
                { number: 13, url: "https://github/pr/13", state: "OPEN" },
              ]);
        }
        return "";
      },
    );
    const status = await new GithubPrAccess(execute).ensureOpen(
      repositoryId,
      "feature",
      "/tmp/worktree",
      "Feature title",
      "Feature body",
      "main",
    );
    expect(status.url).toBe("https://github/pr/13");
    expect(calls[1]).toMatchObject({
      command: "git",
      cwd: "/tmp/worktree",
      args: ["push", "--set-upstream", "origin", "feature"],
    });
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining([
        "create",
        "--base",
        "main",
        "--title",
        "Feature title",
        "--body",
        "Feature body",
        "--repo",
        "acme/widgets",
      ]),
    );
    // No real gh/git invocation ever happened — the fake execute recorded every call.
    expect(
      execute.mock.calls.every(
        ([command]) => command === "git" || command === "gh",
      ),
    ).toBe(true);
  });

  it("uses gh's creation URL while GitHub's list endpoint is lagging", async () => {
    const execute = vi.fn(async (_command: string, args: string[]) =>
      args[1] === "create" ? "https://github.com/acme/widgets/pull/14\n" : "[]",
    );
    const status = await new GithubPrAccess(execute).ensureOpen(
      repositoryId,
      "feature",
      "/tmp/worktree",
      "Title",
      "Body",
      "main",
    );
    expect(status).toMatchObject({
      number: 14,
      state: "OPEN",
      url: "https://github.com/acme/widgets/pull/14",
    });
  });

  it("marks an existing draft PR ready for review", async () => {
    let listCount = 0;
    const execute = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === "list") {
        return JSON.stringify([
          {
            number: 14,
            url: "https://github/pr/14",
            state: "OPEN",
            isDraft: listCount++ === 0,
          },
        ]);
      }
      return "";
    });
    const status = await new GithubPrAccess(execute).ensureOpen(
      repositoryId,
      "branch",
      "/tmp/worktree",
      "Title",
      "Body",
      "main",
    );
    expect(status).toMatchObject({ number: 14, isDraft: false });
    expect(execute.mock.calls[1]?.[1]).toEqual([
      "pr",
      "ready",
      "14",
      "--repo",
      "acme/widgets",
    ]);
  });

  it("reuses an existing open PR without pushing", async () => {
    const execute = vi.fn(async () =>
      JSON.stringify([
        { number: 14, url: "https://github/pr/14", state: "OPEN" },
      ]),
    );
    const status = await new GithubPrAccess(execute).ensureOpen(
      repositoryId,
      "branch",
      "/tmp/worktree",
      "Title",
      "Body",
      "main",
    );
    expect(status.number).toBe(14);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps the merge commit and base branch with a PR-derived commit URL", async () => {
    const execute = vi.fn(async (_command: string, args: string[]) => {
      expect(args.join(" ")).toContain("mergeCommit,baseRefName");
      return JSON.stringify([
        {
          number: 16,
          url: "https://github.example/acme/widgets/pull/16",
          state: "MERGED",
          mergeCommit: { oid: "abc1234def5678" },
          baseRefName: "release",
        },
      ]);
    });
    const status = await new GithubPrAccess(execute).status(
      repositoryId,
      "feature",
    );
    expect(status?.mergeCommit).toEqual({
      oid: "abc1234def5678",
      targetBranch: "release",
      url: "https://github.example/acme/widgets/commit/abc1234def5678",
    });
  });

  it("falls back to the normalized repository id for commit URLs", async () => {
    const execute = vi.fn(async () =>
      JSON.stringify([
        {
          number: 17,
          url: "weird-url",
          state: "MERGED",
          mergeCommit: { oid: "fffeee1112223" },
        },
      ]),
    );
    const status = await new GithubPrAccess(execute).status(
      repositoryId,
      "feature",
    );
    expect(status?.mergeCommit).toEqual({
      oid: "fffeee1112223",
      targetBranch: "",
      url: "https://github.com/acme/widgets/commit/fffeee1112223",
    });
  });

  it("decides commit containment from GitHub compare statuses and memoizes per pair", async () => {
    for (const [status, contained] of [
      ["ahead", true],
      ["identical", true],
      ["behind", false],
      ["diverged", false],
    ] as const) {
      const execute = vi.fn(async (_command: string, args: string[]) => {
        expect(args).toEqual([
          "api",
          "repos/acme/widgets/compare/abc1234...ca9bdff2",
          "--jq",
          ".status",
        ]);
        return `${status}\n`;
      });
      const access = new GithubPrAccess(execute);
      expect(
        await access.containsCommit(repositoryId, "abc1234", "ca9bdff2"),
      ).toBe(contained);
      expect(
        await access.containsCommit(repositoryId, "abc1234", "ca9bdff2"),
      ).toBe(contained);
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("lists newest-first commit subjects from a starting commit and memoizes", async () => {
    const execute = vi.fn(async (_command: string, args: string[]) => {
      expect(args[1]).toBe(
        "repos/acme/widgets/commits?sha=ca9bdff2&per_page=50",
      );
      return JSON.stringify([
        {
          oid: "ca9bdff2aaaa",
          subject: "[Hotfix][pre] bob/fix_stellar_txs [DEV-26273] (#24226)",
        },
        {
          oid: "a8211704bbbb",
          subject:
            "[Hotfix][pre] alice/dai-permit-bug-task [DEV-26101] (#24220)",
        },
      ]);
    });
    const access = new GithubPrAccess(execute);
    const log = await access.commitLog(repositoryId, "ca9bdff2", 50);
    expect(log).toHaveLength(2);
    expect(log[1]).toEqual({
      oid: "a8211704bbbb",
      subject: "[Hotfix][pre] alice/dai-permit-bug-task [DEV-26101] (#24220)",
    });
    await access.commitLog(repositoryId, "ca9bdff2", 50);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      new GithubPrAccess(async (_c, args) => {
        expect(args[1]).toContain("per_page=100");
        return "[]";
      }).commitLog(repositoryId, "ca9bdff2", 500),
    ).resolves.toEqual([]);
    await expect(
      new GithubPrAccess(async () => "{}").commitLog(
        repositoryId,
        "ca9bdff2",
        10,
      ),
    ).rejects.toThrow("Unexpected GitHub commit log payload");
    await expect(
      new GithubPrAccess(async () => "[]").commitLog(
        repositoryId,
        "not-a-sha!",
        10,
      ),
    ).rejects.toThrow("hexadecimal");
  });

  it("rejects containment checks it cannot perform safely", async () => {
    const access = new GithubPrAccess(async () => "total nonsense");
    await expect(
      access.containsCommit(repositoryId, "not-a-sha!", "ca9bdff2"),
    ).rejects.toThrow("hexadecimal");
    await expect(
      access.containsCommit(repositoryId, "abc1234", "ca9bdff2"),
    ).rejects.toThrow("Unexpected GitHub compare status");
    await expect(
      new GithubPrAccess(async () => "ahead").containsCommit(
        "github.com",
        "abc1234",
        "ca9bdff2",
      ),
    ).rejects.toThrow("owner/repo");
  });

  it("omits merge metadata for open PRs", async () => {
    const execute = vi.fn(async () =>
      JSON.stringify([
        {
          number: 18,
          url: "https://github/pr/18",
          state: "OPEN",
          mergeCommit: null,
        },
      ]),
    );
    const status = await new GithubPrAccess(execute).status(
      repositoryId,
      "feature",
    );
    expect(status?.mergeCommit).toBeUndefined();
  });
});
