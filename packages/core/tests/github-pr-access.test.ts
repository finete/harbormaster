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

  it("statusMany answers every branch from one GraphQL call per 20 branches, same mapping as status", async () => {
    const node = {
      number: 12,
      url: "https://github.example/acme/widgets/pull/12",
      state: "MERGED",
      isDraft: false,
      author: { login: "alice" },
      headRefOid: "head",
      reviewDecision: "CHANGES_REQUESTED",
      reviewRequests: { totalCount: 1 },
      reviews: {
        nodes: [{ state: "CHANGES_REQUESTED", commit: { oid: "head" } }],
      },
      mergeCommit: { oid: "fedcba9" },
      baseRefName: "release",
    };
    const execute = vi.fn(async (_command: string, args: string[]) => {
      const heads = args.filter((arg) => /^h\d+=/.test(arg));
      const repository = Object.fromEntries(
        heads.map((head) => {
          const [key, branch] = head.split("=") as [string, string];
          const alias = `b${key.slice(1)}`;
          return [alias, { nodes: branch === "feature" ? [node] : [] }];
        }),
      );
      return JSON.stringify({ data: { repository } });
    });
    const access = new GithubPrAccess(execute);
    const branches = [
      "feature",
      ...Array.from({ length: 24 }, (_, i) => `other-${i}`),
      "feature",
    ];
    const statuses = await access.statusMany(repositoryId, branches);

    // 25 distinct branches -> two calls (20 + 5); branch names only as variables.
    expect(execute).toHaveBeenCalledTimes(2);
    const [command, args] = execute.mock.calls[0] ?? [];
    expect(command).toBe("gh");
    expect(args?.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args).toContain("owner=acme");
    expect(args).toContain("name=widgets");
    expect(args).toContain("h0=feature");
    const query = args?.find((arg) => arg.startsWith("query=")) ?? "";
    expect(query).not.toContain("feature");
    expect(query).toContain(
      "states: [OPEN, CLOSED, MERGED], orderBy: { field: CREATED_AT, direction: DESC }",
    );

    expect(statuses.size).toBe(25);
    expect(statuses.get("other-3")).toBeUndefined();
    expect(statuses.has("other-3")).toBe(true);
    // Same normalized shape the per-branch `gh pr list` path produces.
    const viaList = await new GithubPrAccess(async () =>
      JSON.stringify([
        {
          ...node,
          reviewRequests: [{ login: "r" }],
          reviews: node.reviews.nodes,
        },
      ]),
    ).status(repositoryId, "feature");
    const { checkedAt: _a, ...batched } = statuses.get("feature") ?? {};
    const { checkedAt: _b, ...listed } = viaList ?? {};
    expect(batched).toEqual(listed);
    expect(batched).toMatchObject({
      reviewRequested: true,
      changesRequestedOnHead: true,
      mergeCommit: { oid: "fedcba9", targetBranch: "release" },
    });
  });

  it("statusMany rejects a payload missing a branch's alias instead of reporting no PR", async () => {
    const access = new GithubPrAccess(async () =>
      JSON.stringify({ data: { repository: { b0: { nodes: [] } } } }),
    );
    await expect(access.statusMany(repositoryId, ["a", "b"])).rejects.toThrow(
      /no pull request list for b/,
    );
    await expect(
      new GithubPrAccess(async () => "[]").statusMany(repositoryId, ["a"]),
    ).rejects.toThrow(/no repository/);
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
        "github.com/acme/widgets",
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
      "github.com/acme/widgets",
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

  it("squash-merges by number with the host-qualified --repo form, then returns the merged status", async () => {
    const calls: string[][] = [];
    const execute = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "list") {
        return JSON.stringify([
          {
            number: 21,
            url: "https://github.com/acme/widgets/pull/21",
            state: "MERGED",
            mergeCommit: { oid: "abc1234def5678" },
            baseRefName: "main",
          },
        ]);
      }
      return "";
    });
    const status = await new GithubPrAccess(execute).squashMerge(
      repositoryId,
      21,
      "feature",
    );
    expect(calls[0]).toEqual([
      "pr",
      "merge",
      "21",
      "--repo",
      "github.com/acme/widgets",
      "--squash",
    ]);
    // The follow-up lookup includes merged PRs (state all) for the branch.
    expect(calls[1]).toEqual(
      expect.arrayContaining(["list", "--head", "feature", "--state", "all"]),
    );
    expect(status).toMatchObject({
      number: 21,
      state: "MERGED",
      mergeCommit: { oid: "abc1234def5678", targetBranch: "main" },
    });
  });

  it("rejects a squash merge GitHub does not then report as merged", async () => {
    const execute = vi.fn(async (_command: string, args: string[]) =>
      args[1] === "list"
        ? JSON.stringify([
            { number: 21, url: "https://github/pr/21", state: "OPEN" },
          ])
        : "",
    );
    await expect(
      new GithubPrAccess(execute).squashMerge(repositoryId, 21, "feature"),
    ).rejects.toThrow("squash merge did not complete");
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
    // No base branch reported: targetBranch is left for the manager to
    // fill from the repository's default branch.
    expect(status?.mergeCommit).toEqual({
      oid: "fffeee1112223",
      url: "https://github.com/acme/widgets/commit/fffeee1112223",
    });
  });

  it("keeps a GitHub Enterprise host: --repo HOST/OWNER/REPO and gh api --hostname", async () => {
    const calls: string[][] = [];
    const access = new GithubPrAccess(async (_command, args) => {
      calls.push(args);
      return args[0] === "api" ? "ahead\n" : "[]";
    });
    await access.status("ghe.example.com/acme/widgets", "feature");
    await access.containsCommit(
      "ghe.example.com/acme/widgets",
      "abc1234",
      "ca9bdff2",
    );
    expect(calls[0]).toEqual(
      expect.arrayContaining(["--repo", "ghe.example.com/acme/widgets"]),
    );
    expect(calls[1]).toEqual([
      "api",
      "repos/acme/widgets/compare/abc1234...ca9bdff2",
      "--jq",
      ".status",
      "--hostname",
      "ghe.example.com",
    ]);
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

  it("honors HARBORMASTER_GH_COMMAND as a command override for the default execute (e2e fake binaries)", async () => {
    const previous = process.env.HARBORMASTER_GH_COMMAND;
    process.env.HARBORMASTER_GH_COMMAND = "/bin/echo";
    try {
      // No execute override: exercises the real default, which should run
      // the fake command instead of "gh" and otherwise behave the same.
      await expect(
        new GithubPrAccess().status(repositoryId, "feature"),
      ).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.HARBORMASTER_GH_COMMAND;
      else process.env.HARBORMASTER_GH_COMMAND = previous;
    }
  });
});
