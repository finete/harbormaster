// resolvePrimaryLaunch must catch a binding whose worktree directory no
// longer exists BEFORE claiming the one-shot session slot / initial prompt,
// so a pane never spawns pi into a dead cwd (the bare `[process exited with
// code 1]` the board showed for an old `.pi-home-worktrees` task whose
// worktree had been reaped). See primary-launch.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PrimaryLaunchCore,
  PrimaryLaunchHarness,
} from "../src/main/primary-launch";
import { resolvePrimaryLaunch } from "../src/main/primary-launch";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A core stub whose only live binding points at `worktreePath`; records whether either one-shot claim was invoked. */
function fakeCore(worktreePath: string | undefined): {
  core: PrimaryLaunchCore;
  claims: { session: number; prompt: number };
} {
  const claims = { session: 0, prompt: 0 };
  const core: PrimaryLaunchCore = {
    getTaskWorkspace: async () =>
      worktreePath
        ? ({
            id: "b1",
            taskId: "t1",
            worktreePath,
            branch: "feature/x",
            detached: false,
            createdAt: "",
            updatedAt: "",
          } as Awaited<ReturnType<PrimaryLaunchCore["getTaskWorkspace"]>>)
        : undefined,
    claimSessionLaunch: async () => {
      claims.session += 1;
      return undefined;
    },
    claimInitialPrompt: async () => {
      claims.prompt += 1;
      return undefined;
    },
  };
  return { core, claims };
}

const harness: PrimaryLaunchHarness = {
  buildLaunchSpec: (input) => ({
    // A command that definitely exists so a *present* worktree would pass the
    // commandExists gate — isolates the worktree-existence check under test.
    command: "/bin/sh",
    args: [],
    cwd: input.workspacePath,
    env: {},
  }),
};

describe("resolvePrimaryLaunch worktree existence", () => {
  it("flags a missing worktree and claims neither the session nor the prompt", async () => {
    const gone = join(tmpdir(), `harbormaster-missing-${Date.now()}`);
    const { core, claims } = fakeCore(gone);

    const result = await resolvePrimaryLaunch("t1", "/state", core, harness);

    expect(result.worktreeMissing).toBe(true);
    expect(result.spec).toBeUndefined();
    expect(result.commandMissing).toBe(false);
    // One-shot claims must survive a launch that cannot happen.
    expect(claims.session).toBe(0);
    expect(claims.prompt).toBe(0);
  });

  it("launches normally when the worktree exists", async () => {
    const live = mkdtempSync(join(tmpdir(), "harbormaster-live-"));
    tempDirs.push(live);
    const { core, claims } = fakeCore(live);

    const result = await resolvePrimaryLaunch("t1", "/state", core, harness);

    expect(result.worktreeMissing).toBe(false);
    expect(result.commandMissing).toBe(false);
    expect(result.spec?.cwd).toBe(live);
    expect(claims.session).toBe(1);
    expect(claims.prompt).toBe(1);
  });

  it("reports no worktree when the task has no binding", async () => {
    const { core } = fakeCore(undefined);

    const result = await resolvePrimaryLaunch("t1", "/state", core, harness);

    expect(result.binding).toBeUndefined();
    expect(result.worktreeMissing).toBe(false);
    expect(result.spec).toBeUndefined();
  });
});
