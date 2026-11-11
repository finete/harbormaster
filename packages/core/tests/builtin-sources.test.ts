// The built-in sources: `version-endpoint` (ported from pi-home's
// tests/unit/version-endpoint-hook.test.ts, now source-side logic) and
// `github` (per-task PR facts, opt-in unbound searches).

import { describe, expect, it, vi } from "vitest";
import type { Task } from "../src/contracts/model.js";
import type {
  RuleStageView,
  Snapshot,
  SourceContext,
} from "../src/contracts/rules.js";
import { parseDeployedVersion } from "../src/engines/deployment.js";
import { toRuleTaskView } from "../src/engines/rules/views.js";
import {
  githubSource,
  pullRequestFacts,
} from "../src/engines/sources/github-source.js";
import {
  stageDeployed,
  versionEndpointSource,
} from "../src/engines/sources/version-endpoint-source.js";

const REPO = "github.com/acme/widgets";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    kind: "task",
    state: "awaiting",
    awaiting: { kind: "deploy", stageId: "pre", stageLabel: "Preprod deploy" },
    title: "Permit bug",
    initialPrompt: "",
    repositoryId: REPO,
    branch: "alice/dai-permit-bug-task",
    pr: {
      number: 24161,
      url: `https://${REPO}/pull/24161`,
      state: "merged",
      mergeCommit: { oid: "abc1234def5678", targetBranch: "main" },
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    stateChangedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const stage = (options: Record<string, unknown> = {}): RuleStageView => ({
  id: "pre",
  label: "Preprod deploy",
  hook: "version-endpoint",
  options: { url: "https://api.preprod.example.com/version", ...options },
});

const HOTFIX = {
  oid: "a82117049087dd39410dc04b8062a9c4ad726ac0",
  subject:
    "[Hotfix][pre] alice/dai-keyber-permit-issue alice/dai-permit-bug-task [DEV-26101] (#24220)",
};
const NOISE = {
  oid: "ca9bdff2aaaaaaaa",
  subject: "[Hotfix][pre] bob/fix_stellar_txs [DEV-26273] (#24226)",
};

function services(
  contained: boolean,
  log: Array<{ oid: string; subject: string }> = [],
) {
  return {
    github: {
      observed: () => undefined,
      containsCommit: vi.fn(async () => contained),
      commitLog: vi.fn(async () => log),
    },
    http: { fetchText: vi.fn(async () => "v0.115.20+ca9bdff2") },
  };
}

async function deployed(
  options: Record<string, unknown>,
  svc: ReturnType<typeof services>,
  overrides: Partial<Task> = {},
  document = "v0.115.20+ca9bdff2",
) {
  return stageDeployed(
    toRuleTaskView(task(overrides)),
    REPO,
    stage(options),
    { services: svc },
    async () => parseDeployedVersion(document),
  );
}

describe("version-endpoint source: is the merge deployed at a stage?", () => {
  it("yes when the merge commit is inside the deployed commit, without scanning hotfixes", async () => {
    const svc = services(true);
    expect(await deployed({}, svc)).toBe(true);
    expect(svc.github.containsCommit).toHaveBeenCalledWith(
      REPO,
      "abc1234def5678",
      "ca9bdff2",
    );
    expect(svc.github.commitLog).not.toHaveBeenCalled();
  });

  it("detects a cherry-picked hotfix by branch name, or by PR number (#241610 is not #24161)", async () => {
    const svc = services(false, [NOISE, HOTFIX]);
    expect(await deployed({}, svc)).toBe(true);
    expect(svc.github.commitLog).toHaveBeenCalledWith(REPO, "ca9bdff2", 100);

    const byNumber = services(false, [
      { oid: "feedbeef1234567", subject: "cherry-pick fix from (#24161)" },
    ]);
    expect(await deployed({}, byNumber, { branch: "other" })).toBe(true);
    const near = services(false, [
      { oid: "feedbeef1234567", subject: "unrelated (#241610)" },
    ]);
    expect(await deployed({}, near, { branch: "other" })).toBe(false);
  });

  it("respects hotfixScan and hotfixDepth (1-100)", async () => {
    const disabled = services(false, [HOTFIX]);
    expect(await deployed({ hotfixScan: false }, disabled)).toBe(false);
    expect(disabled.github.commitLog).not.toHaveBeenCalled();
    const shallow = services(false, [HOTFIX]);
    expect(await deployed({ hotfixDepth: 25 }, shallow)).toBe(true);
    expect(shallow.github.commitLog).toHaveBeenCalledWith(REPO, "ca9bdff2", 25);
    await expect(deployed({ hotfixDepth: 0 }, services(false))).rejects.toThrow(
      "hotfixDepth",
    );
    await expect(
      deployed({ hotfixDepth: 101 }, services(false)),
    ).rejects.toThrow("hotfixDepth");
  });

  it("is not deployed without a merge commit; fails loudly on bad configuration or data", async () => {
    expect(
      await deployed({}, services(true), {
        pr: { number: 1, state: "open" },
      }),
    ).toBe(false);
    await expect(deployed({ url: undefined }, services(true))).rejects.toThrow(
      "https options.url",
    );
    await expect(
      deployed({ url: "http://insecure" }, services(true)),
    ).rejects.toThrow("https options.url");
    await expect(
      deployed({}, services(true), {}, "<html>down</html>"),
    ).rejects.toThrow("Unrecognized deployed version");
  });
});

function sourceContext(
  tasks: Task[],
  overrides: Partial<SourceContext> = {},
): SourceContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    now: () => new Date("2026-01-01T00:00:00Z"),
    tasks: tasks.map(toRuleTaskView),
    repositories: [
      {
        id: REPO,
        deployment: {
          stages: [
            stage({ url: "https://pre.example/version" }),
            {
              id: "prod",
              label: "Production",
              hook: "version-endpoint",
              options: { url: "https://prod.example/version" },
            },
          ],
        },
      },
    ],
    settings: {},
    previous: [],
    cursor: undefined,
    setCursor: () => {},
    services: {
      github: {
        observed: () => undefined,
        containsCommit: async (_r, _a, d) => d === "2222222",
        commitLog: async () => [],
      },
      http: {
        fetchText: async (url) =>
          url.includes("pre.") ? "v1+1111111" : "v1+2222222",
      },
    },
    warn: (message) => warnings.push(message),
    warnings,
    ...overrides,
  };
}

describe("version-endpoint source snapshots", () => {
  it("per task: the furthest deployed stage, what comes next, whether it lands; per stage: the deployed commit", async () => {
    const ctx = sourceContext([
      task(),
      task({ id: "t2", state: "dev", awaiting: undefined }),
    ]);
    const snapshots = (await versionEndpointSource.snapshot?.(ctx)) ?? [];
    expect(snapshots).toEqual([
      {
        subject: "task/t1",
        entity: "deployment",
        // prod (a later stage) already has it: the scan jumps past pre.
        facts: {
          stageId: "pre",
          satisfiedStageId: "prod",
          next: null,
          land: true,
        },
      },
      {
        subject: `repo/${REPO}/stage/prod`,
        entity: "stage",
        facts: { commit: "2222222", version: "v1+2222222" },
      },
    ]);
    expect(ctx.warnings).toEqual([]);
  });

  it("a failing endpoint is a warning and keeps the previous facts (stale)", async () => {
    const previous: Snapshot[] = [
      {
        subject: `repo/${REPO}/stage/pre`,
        entity: "stage",
        facts: { commit: "x" },
      },
    ];
    const ctx = sourceContext([task()], { previous });
    ctx.services.http.fetchText = async () => {
      throw new Error("ECONNRESET");
    };
    const snapshots = (await versionEndpointSource.snapshot?.(ctx)) ?? [];
    expect(snapshots).toEqual([
      { subject: "task/t1", entity: "deployment", facts: {}, stale: true },
      { ...previous[0], stale: true },
    ]);
    expect(ctx.warnings).toEqual(["Permit bug: ECONNRESET"]);
  });
});

describe("github source", () => {
  it("maps an observed PR to diffable facts (absent values null)", () => {
    expect(
      pullRequestFacts({
        number: 7,
        url: "u",
        state: "OPEN",
        isDraft: true,
        reviewDecision: "CHANGES_REQUESTED",
        reviewRequested: true,
        reviewSubmitted: false,
        headRefOid: "h",
        viewerIsAuthor: false,
        unresolvedThreads: 2,
      }),
    ).toEqual({
      number: 7,
      url: "u",
      state: "draft",
      reviewDecision: "changes_requested",
      changesRequestedOnHead: null,
      humanFeedbackOnHead: null,
      reviewRequested: true,
      reviewSubmitted: false,
      headSha: "h",
      merged: false,
      mergedAt: null,
      mergeCommit: null,
      closed: false,
      isDraft: true,
      checks: null,
      unresolvedThreads: 2,
      lastAuthorActivityAt: null,
      lastReviewerActivityAt: null,
      author: null,
      viewerIsAuthor: false,
    });
  });

  it("reports observed tasks, keeps unobserved known ones stale, and drops tasks without a PR", async () => {
    const observed = new Map<string, { status?: never }>([
      [
        "a",
        {
          status: {
            number: 1,
            url: "u",
            state: "OPEN",
            isDraft: false,
            reviewRequested: false,
            reviewSubmitted: false,
          } as never,
        },
      ],
      ["b", {}],
    ]);
    const ctx = sourceContext(
      [
        task({ id: "a", state: "dev" }),
        task({ id: "b", state: "dev" }),
        task({ id: "c", state: "dev" }),
      ],
      {
        previous: [{ subject: "task/c", entity: "pr", facts: { number: 3 } }],
      },
    );
    ctx.services.github.observed = (id) => observed.get(id);
    const snapshots = (await githubSource.snapshot?.(ctx)) ?? [];
    expect(snapshots.map((s) => [s.subject, s.stale ?? false])).toEqual([
      ["task/a", false],
      ["task/c", true],
    ]);
  });

  it("searches review requests / mentions only when opted in, at most every searchIntervalMs", async () => {
    const search = vi.fn(async () => [
      {
        repository: "github.com/acme/api",
        number: 9,
        url: "https://github.com/acme/api/pull/9",
        title: "Fix",
        author: "bob",
      },
    ]);
    let cursor: unknown;
    const make = (now: string, previous: Snapshot[] = []) => {
      const ctx = sourceContext([], {
        settings: { watchReviewRequests: true },
        now: () => new Date(now),
        cursor,
        setCursor: (next) => {
          cursor = next;
        },
        previous,
      });
      ctx.services.github.searchPullRequests = search;
      return ctx;
    };
    const off = sourceContext([]);
    off.services.github.searchPullRequests = search;
    expect(await githubSource.snapshot?.(off)).toEqual([]);
    expect(search).not.toHaveBeenCalled();

    const first =
      (await githubSource.snapshot?.(make("2026-01-01T00:00:00Z"))) ?? [];
    expect(first).toEqual([
      {
        subject: "github/reviewRequest/github.com/acme/api#9",
        entity: "reviewRequest",
        facts: {
          repository: "github.com/acme/api",
          number: 9,
          url: "https://github.com/acme/api/pull/9",
          title: "Fix",
          author: "bob",
        },
      },
    ]);
    expect(search).toHaveBeenCalledWith("is:pr is:open review-requested:@me");
    const soon =
      (await githubSource.snapshot?.(make("2026-01-01T00:01:00Z", first))) ??
      [];
    expect(soon).toEqual([{ ...first[0], stale: true }]);
    expect(search).toHaveBeenCalledTimes(1);
    await githubSource.snapshot?.(make("2026-01-01T00:06:00Z", first));
    expect(search).toHaveBeenCalledTimes(2);
  });
});
