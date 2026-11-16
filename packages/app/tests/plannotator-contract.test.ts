// The four facts the app relies on from Plannotator (docs/plannotator.md
// "What we rely on from Plannotator"), pinned against a REAL `plannotator`
// on PATH; skipped when none is installed (the e2e runs a fake that honours
// the same facts, e2e/fake-plannotator.ts):
//   1. `plannotator --version` prints a semver.
//   2. PLANNOTATOR_BROWSER=<path containing "/"> runs that path with the
//      session URL as its only argument.
//   3. The session prints `Plannotator session ready: <url>` on stderr
//      before opening anything.
//   4. The review page is frameable (no X-Frame-Options, no frame-ancestors).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

function whichPlannotator(): string | undefined {
  try {
    return (
      execFileSync("which", ["plannotator"], { encoding: "utf8" }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

const binary = whichPlannotator();
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!binary)("Plannotator contract (real binary)", () => {
  it("1. --version prints a semver", () => {
    const out = execFileSync(binary as string, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(out).toMatch(/\d+\.\d+\.\d+/);
  });

  it("2-4. a review session announces its URL on stderr, runs PLANNOTATOR_BROWSER with it, and is frameable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-plannotator-contract-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: repo },
    );
    writeFileSync(join(repo, "a.txt"), "two\n");

    const argsFile = join(dir, "browser-args");
    const browser = join(dir, "browser.sh");
    writeFileSync(
      browser,
      `#!/bin/sh\nprintf '%s\\n' "$#" "$@" > "${argsFile}"\n`,
    );
    chmodSync(browser, 0o755);

    let stderr = "";
    const child = spawn(binary as string, ["review"], {
      cwd: repo,
      env: { ...process.env, PLANNOTATOR_BROWSER: browser, BROWSER: browser },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await expect
      .poll(() => existsSync(argsFile), { timeout: 30_000 })
      .toBe(true);
    const [count, url] = readFileSync(argsFile, "utf8").trim().split("\n");
    // 2. Exactly one argument: the session URL.
    expect(count).toBe("1");
    expect(url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+/);
    // 3. The ready line, with that URL, on stderr (the pty fallback's
    // anchor; that it comes before the open is Plannotator's documented
    // behaviour, not observable from here without racing the pipe).
    await expect
      .poll(() => stderr, { timeout: 10_000 })
      .toContain(`Plannotator session ready: ${url}`);
    // 4. Frameable.
    const response = await fetch(url as string);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy") ?? "").not.toMatch(
      /frame-ancestors/i,
    );
    child.kill("SIGTERM");
  });
});
