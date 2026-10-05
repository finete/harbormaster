// Ported from pi-home's tests/unit/version-endpoint-hook.test.ts, adapted to
// Harbormaster's StageHookInput shape (repositoryId instead of a full
// repository ref).

import { describe, expect, it, vi } from "vitest";
import type {
  CommitLogEntry,
  StageHookHelpers,
  StageHookInput,
} from "../src/contracts/addons.js";
import { versionEndpointHook } from "../src/engines/movers/version-endpoint-hook.js";

const input = (overrides: Partial<StageHookInput> = {}): StageHookInput => ({
  repositoryId: "github.com/acme/widgets",
  commit: { oid: "abc1234def5678", targetBranch: "main" },
  pullRequest: {
    number: 24161,
    url: "https://github.com/acme/widgets/pull/24161",
  },
  branch: "alice/dai-permit-bug-task",
  stage: { id: "pre", label: "Preprod deploy" },
  options: { url: "https://api.preprod.example.com/version" },
  ...overrides,
});

const helpers = (
  document: string,
  contained: boolean,
  log: CommitLogEntry[] = [],
): StageHookHelpers & { commitLog: ReturnType<typeof vi.fn> } => ({
  fetchText: vi.fn(async () => document),
  containsCommit: vi.fn(async () => contained),
  commitLog: vi.fn(async () => log),
});

const HOTFIX: CommitLogEntry = {
  oid: "a82117049087dd39410dc04b8062a9c4ad726ac0",
  subject:
    "[Hotfix][pre] alice/dai-keyber-permit-issue alice/dai-permit-bug-task [DEV-26101] (#24220)",
};
const NOISE: CommitLogEntry = {
  oid: "ca9bdff2aaaaaaaa",
  subject: "[Hotfix][pre] bob/fix_stellar_txs [DEV-26273] (#24226)",
};

describe("built-in version-endpoint hook", () => {
  const hook = versionEndpointHook;

  it("is satisfied when the squash commit is inside the deployed commit, without scanning hotfixes", async () => {
    const deployed = helpers("v0.115.20+ca9bdff2", true);
    await expect(hook.check(input(), deployed)).resolves.toEqual({
      satisfied: true,
      detail: "Preprod deploy is at v0.115.20+ca9bdff2",
    });
    expect(deployed.containsCommit).toHaveBeenCalledWith(
      "abc1234def5678",
      "ca9bdff2",
    );
    expect(deployed.commitLog).not.toHaveBeenCalled();
  });

  it("detects a cherry-picked hotfix by branch name in deployed commit subjects", async () => {
    const deployed = helpers("v0.115.20+ca9bdff2", false, [NOISE, HOTFIX]);
    await expect(hook.check(input(), deployed)).resolves.toEqual({
      satisfied: true,
      detail: `Preprod deploy is at v0.115.20+ca9bdff2 via hotfix a821170 (${HOTFIX.subject})`,
    });
    expect(deployed.commitLog).toHaveBeenCalledWith("ca9bdff2", 100);
  });

  it("detects a hotfix by PR number when the branch is unknown", async () => {
    const byNumber = helpers("v0.115.20+ca9bdff2", false, [
      { oid: "feedbeef1234567", subject: "cherry-pick fix from (#24161)" },
    ]);
    const { branch: _branch, ...withoutBranch } = input();
    await expect(hook.check(withoutBranch, byNumber)).resolves.toMatchObject({
      satisfied: true,
    });
    // #241610 must not match #24161.
    const near = helpers("v0.115.20+ca9bdff2", false, [
      { oid: "feedbeef1234567", subject: "unrelated (#241610)" },
    ]);
    await expect(hook.check(withoutBranch, near)).resolves.toMatchObject({
      satisfied: false,
      detail: "Preprod deploy is at v0.115.20+ca9bdff2",
    });
  });

  it("respects hotfixScan and hotfixDepth options, bounding depth to 1-100", async () => {
    const disabled = helpers("v0.115.20+ca9bdff2", false, [HOTFIX]);
    await expect(
      hook.check(
        input({ options: { url: "https://x", hotfixScan: false } }),
        disabled,
      ),
    ).resolves.toMatchObject({ satisfied: false });
    expect(disabled.commitLog).not.toHaveBeenCalled();

    const shallow = helpers("v0.115.20+ca9bdff2", false, [HOTFIX]);
    await expect(
      hook.check(
        input({ options: { url: "https://x", hotfixDepth: 25 } }),
        shallow,
      ),
    ).resolves.toMatchObject({ satisfied: true });
    expect(shallow.commitLog).toHaveBeenCalledWith("ca9bdff2", 25);

    await expect(
      hook.check(
        input({ options: { url: "https://x", hotfixDepth: 0 } }),
        helpers("v1.2.3+abcdef01", false),
      ),
    ).rejects.toThrow("hotfixDepth");
    await expect(
      hook.check(
        input({ options: { url: "https://x", hotfixDepth: 101 } }),
        helpers("v1.2.3+abcdef01", false),
      ),
    ).rejects.toThrow("hotfixDepth");

    const { branch: _b, pullRequest: _pr, ...anonymous } = input();
    const anonymousHelpers = helpers("v0.115.20+ca9bdff2", false, [HOTFIX]);
    await expect(
      hook.check(anonymous, anonymousHelpers),
    ).resolves.toMatchObject({
      satisfied: false,
    });
    expect(anonymousHelpers.commitLog).not.toHaveBeenCalled();
  });

  it("stays unsatisfied without a merged commit and fails loudly on bad configuration or data", async () => {
    const { commit: _commit, ...withoutCommit } = input();
    await expect(
      hook.check(withoutCommit, helpers("v0.115.20+ca9bdff2", true)),
    ).resolves.toMatchObject({
      satisfied: false,
    });
    await expect(
      hook.check(input({ options: {} }), helpers("v1+x", true)),
    ).rejects.toThrow("https options.url");
    await expect(
      hook.check(
        input({ options: { url: "http://insecure" } }),
        helpers("v1+x", true),
      ),
    ).rejects.toThrow("https options.url");
    await expect(
      hook.check(input(), helpers("<html>down</html>", true)),
    ).rejects.toThrow("Unrecognized deployed version");
  });
});
