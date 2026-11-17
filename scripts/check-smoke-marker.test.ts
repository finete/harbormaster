import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSmokeMarker, MARKER_FILE } from "./check-smoke-marker.mjs";

let repo: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}

function commitFile(path: string, content: string): string {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  git("add", "-A");
  git("commit", "-q", "-m", `touch ${path}`);
  return git("rev-parse", "HEAD");
}

function writeMarker(commit: string): void {
  writeFileSync(
    join(repo, MARKER_FILE),
    JSON.stringify({
      commit,
      at: "2026-11-17T00:00:00.000Z",
      harnesses: ["pi"],
    }),
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "smoke-marker-"));
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), `${MARKER_FILE}\n`);
  commitFile("README.md", "hi\n");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("checkSmokeMarker", () => {
  it("fails without a marker", () => {
    const result = checkSmokeMarker(repo);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no \.real-smoke-ok/);
  });

  it("fails on a marker that is not JSON or names no known commit", () => {
    writeFileSync(join(repo, MARKER_FILE), "{");
    expect(checkSmokeMarker(repo).message).toMatch(/not JSON/);
    writeMarker("0".repeat(40));
    expect(checkSmokeMarker(repo).message).toMatch(/not in this repository/);
  });

  it("passes when no harness path was ever touched", () => {
    writeMarker(git("rev-parse", "HEAD"));
    expect(checkSmokeMarker(repo).ok).toBe(true);
  });

  it("passes at or after the last harness change, fails before it", () => {
    const before = git("rev-parse", "HEAD");
    const harness = commitFile("packages/core/src/harness/pi.ts", "v1\n");
    writeMarker(before);
    expect(checkSmokeMarker(repo)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/predates the last harness change/),
    });
    writeMarker(harness);
    expect(checkSmokeMarker(repo).ok).toBe(true);
    // Unrelated later commits keep it fresh.
    const later = commitFile("docs/notes.md", "x\n");
    expect(checkSmokeMarker(repo).ok).toBe(true);
    writeMarker(later);
    expect(checkSmokeMarker(repo).ok).toBe(true);
  });

  it("treats fakes and contracts as harness paths, other e2e files not", () => {
    const base = git("rev-parse", "HEAD");
    writeMarker(base);
    commitFile("packages/app/e2e/smoke.spec.ts", "x\n");
    expect(checkSmokeMarker(repo).ok).toBe(true);
    commitFile("packages/app/e2e/fake-claude.ts", "x\n");
    expect(checkSmokeMarker(repo).ok).toBe(false);
    writeMarker(git("rev-parse", "HEAD"));
    expect(checkSmokeMarker(repo).ok).toBe(true);
    commitFile("packages/app/e2e/contracts/pi.ts", "x\n");
    expect(checkSmokeMarker(repo).ok).toBe(false);
  });

  it("fails on a marker from a branch that lacks the harness change", () => {
    const base = git("rev-parse", "HEAD");
    commitFile("packages/core/src/harness/pi.ts", "v1\n");
    git("checkout", "-q", "-b", "side", base);
    const side = commitFile("docs/side.md", "x\n");
    git("checkout", "-q", "-");
    writeMarker(side);
    expect(checkSmokeMarker(repo).ok).toBe(false);
  });

  it("fails while harness paths have uncommitted changes", () => {
    const head = commitFile("packages/core/src/harness/pi.ts", "v1\n");
    writeMarker(head);
    writeFileSync(join(repo, "packages/core/src/harness/pi.ts"), "v2\n");
    expect(checkSmokeMarker(repo)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/uncommitted harness changes/),
    });
  });
});
