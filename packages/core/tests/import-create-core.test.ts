// createCore's import wiring: one `home` option points every built-in reader
// at a fake home (the recorded fixtures), and git tells a linked worktree
// from a main checkout (docs/import.md F9) in a real temp repository.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitRepositoryAccess } from "../src/access/git-repository-access.js";
import { createCore } from "../src/index.js";
import { materializeFixture } from "./helpers/import-fixtures.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createCore({ import: { home } })", () => {
  it("lists the recorded sessions of all four CLIs from the fake home, with fake processes", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "hm-import-core-home-")));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hm-import-core-root-")));
    const stateDir = mkdtempSync(join(tmpdir(), "hm-import-core-state-"));
    cleanup.push(home, root, stateDir);
    mkdirSync(join(root, "wt"));
    for (const harness of ["pi", "claude-code", "codex", "cursor"]) {
      materializeFixture(harness, { home, root });
    }
    const core = createCore({
      stateDir,
      import: {
        home,
        processes: {
          listRunningAgents: async () => [{ harness: "cursor", pid: 1, cwd: join(root, "wt") }],
        },
      },
    });
    const listing = await core.commands.listImportCandidates();
    const candidates = listing.groups.flatMap((group) => group.candidates);
    // all four recorded sessions ran in the same folder: one candidate with four sessions
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate?.sessions.map((s) => s.harness).sort()).toEqual(["claude-code", "codex", "cursor", "pi"]);
    expect(candidate?.sessions.every((s) => s.userPrompts === 3)).toBe(true);
    // a live Cursor process in the folder: its session is running, no fork (capability read from the adapter)
    const cursor = candidate?.sessions.find((s) => s.harness === "cursor");
    expect(cursor).toMatchObject({ canFork: false, running: { where: "terminal", precision: "folder" } });
    expect(candidate?.sessions.filter((s) => s.harness !== "cursor").every((s) => s.canFork)).toBe(true);
    expect(listing.sources.map((s) => s.id)).toEqual(["pi", "claude-code", "codex", "cursor", "herdr"]);
    core.close();
  });
});

describe("LocalGitRepositoryAccess.inspectFolder", () => {
  it("tells a linked worktree, a main checkout, a subfolder and a plain folder apart", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hm-import-git-")));
    cleanup.push(root);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    const main = join(root, "repo");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "remote", "add", "origin", "git@github.com:Acme/Widgets.git");
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", "-b", "feature/x", wt);
    mkdirSync(join(main, "sub"));
    mkdirSync(join(root, "plain"));
    const access = new LocalGitRepositoryAccess();
    expect(await access.inspectFolder(wt)).toEqual({
      kind: "worktree", repositoryId: "github.com/acme/widgets", mainCheckout: main, branch: "feature/x",
    });
    expect(await access.inspectFolder(main)).toEqual({
      kind: "checkout", repositoryId: "github.com/acme/widgets", mainCheckout: main, branch: "main",
    });
    expect(await access.inspectFolder(join(main, "sub"))).toEqual({ kind: "folder" });
    expect(await access.inspectFolder(join(root, "plain"))).toEqual({ kind: "folder" });
    expect(await access.inspectFolder(join(root, "missing"))).toEqual({ kind: "folder" });
    git(wt, "checkout", "-q", "--detach");
    expect((await access.inspectFolder(wt)).branch).toBeUndefined();
  });
});
