// e2e helper for the import specs: lays the recorded agent-session fixtures
// (packages/core/tests/fixtures/import/<harness>/<version>/, recorded from
// the real CLIs) out as a fake home, with `__ROOT__` / `__HOME__` filled in,
// and shifts every recorded timestamp so the sessions are minutes old
// (the list shows the last 30 days and pre-ticks the last 7). Mirrors
// core's tests/helpers/import-fixtures.ts (which uses import.meta, so the
// Playwright CJS loader cannot share it).
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const FIXTURES = path.join(
  __dirname,
  "..",
  "..",
  "core",
  "tests",
  "fixtures",
  "import",
);

const STORE_DIR: Record<string, string> = {
  pi: ".pi/agent",
  "claude-code": ".claude",
  codex: ".codex",
  cursor: ".cursor",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}

/** Copy `harness`'s recorded store into `<home>/<store dir>`, its sessions having run in `<root>/wt`. */
export function materializeFixture(
  harness: string,
  home: string,
  root: string,
): void {
  const [version] = readdirSync(path.join(FIXTURES, harness));
  const source = path.join(FIXTURES, harness, version as string);
  const recording = JSON.parse(
    readFileSync(path.join(source, "recording.json"), "utf8"),
  ) as { recordedAt: string };
  const shift = Date.now() - 5 * 60_000 - Date.parse(recording.recordedAt);
  const slug = (value: string) => value.replace(/[/.]/g, "-");
  const fill = (text: string) =>
    text
      .split("__ROOT__")
      .join(root)
      .split("__HOME__")
      .join(home)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) =>
        new Date(Date.parse(iso) + shift).toISOString(),
      )
      .replace(
        /"(createdAtMs|updatedAtMs)":\s*(\d+)/g,
        (_all, key: string, ms: string) => `"${key}":${Number(ms) + shift}`,
      );
  const store = path.join(home, STORE_DIR[harness] as string);
  for (const file of walk(source)) {
    const relative = file.slice(source.length + 1);
    if (relative === "recording.json") continue;
    const target = path.join(
      store,
      relative
        .split("__ROOT__")
        .join(slug(root))
        .split("__HOME__")
        .join(slug(home)),
    );
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, fill(readFileSync(file, "utf8")));
  }
}

/** `<root>/repo` (origin `github.com/acme/<name>`) with a linked worktree `<root>/wt` on `branch`. */
export function seedWorktreeRepo(
  root: string,
  name: string,
  branch: string,
): void {
  const main = path.join(root, "repo");
  mkdirSync(main, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  git(main, "init", "-q", "-b", "main");
  git(
    main,
    "-c",
    "user.name=Harbormaster E2E",
    "-c",
    "user.email=harbormaster-e2e@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  git(main, "remote", "add", "origin", `https://github.com/acme/${name}.git`);
  git(main, "worktree", "add", "-q", "-b", branch, path.join(root, "wt"));
}
