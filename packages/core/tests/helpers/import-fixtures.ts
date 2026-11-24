// Test helper: lays a recorded import fixture
// (`fixtures/import/<harness>/<version>/`, recorded by
// scripts/record-import-fixtures.mjs) out as a fake home, replacing the
// `__ROOT__` / `__HOME__` placeholders with real temp paths.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const IMPORT_FIXTURES = join(HERE, "..", "fixtures", "import");

/** Where each harness keeps its store, relative to the home folder. */
const STORE_DIR: Record<string, string> = {
  pi: ".pi/agent",
  "claude-code": ".claude",
  codex: ".codex",
  cursor: ".cursor",
};

export function fixtureVersion(harness: string): string {
  const versions = readdirSync(join(IMPORT_FIXTURES, harness));
  if (versions.length !== 1) {
    throw new Error(`expected one recorded version of ${harness}`);
  }
  return versions[0] as string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export interface MaterializedFixture {
  home: string;
  /** What `__ROOT__` became: the recording's temp root (`<root>/wt` is the linked worktree). */
  root: string;
  version: string;
  recording: { prompts: string[]; files: string[] };
}

/** Copy `harness`'s recorded store into `<home>/<store dir>`, placeholders filled in. */
export function materializeFixture(
  harness: string,
  into: { home?: string; root?: string } = {},
): MaterializedFixture {
  const version = fixtureVersion(harness);
  const source = join(IMPORT_FIXTURES, harness, version);
  const home = into.home ?? mkdtempSync(join(tmpdir(), "hm-import-home-"));
  const root = into.root ?? mkdtempSync(join(tmpdir(), "hm-import-root-"));
  const fill = (text: string) =>
    text.split("__ROOT__").join(root).split("__HOME__").join(home);
  const store = join(home, STORE_DIR[harness] as string);
  for (const file of walk(source)) {
    const relative = file.slice(source.length + 1);
    if (relative === "recording.json") continue;
    // In a path the placeholder is the slug a store makes of the folder
    // (`/` and `.` become `-`), never a nested directory.
    const slug = (path: string) => path.replace(/[/.]/g, "-");
    const target = join(
      store,
      relative
        .split("__ROOT__")
        .join(slug(root))
        .split("__HOME__")
        .join(slug(home)),
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fill(readFileSync(file, "utf8")));
  }
  const recording = JSON.parse(
    readFileSync(join(source, "recording.json"), "utf8"),
  );
  return { home, root, version, recording };
}
