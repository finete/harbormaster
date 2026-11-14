// Resource Access: the rules directory, `<stateDir>/rules/`. Reads the
// global `rules.yaml` and every `repos/<repository id>.yaml` (repository
// ids contain slashes, so `repos/github.com/acme/api.yaml`), writes the
// first-run defaults, and imports the JS escape-hatch modules rules point
// at (`js:./checks.mjs#fn`) — only from inside the rules dir, re-imported
// after an edit.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuleFileText, RulesFileAccess } from "../contracts/rules.js";

const GLOBAL_FILE = "rules.yaml";
const REPOS_DIR = "repos";

export class LocalRulesFileAccess implements RulesFileAccess {
  constructor(private readonly dir: string) {}

  async hasGlobalRules(): Promise<boolean> {
    return stat(join(this.dir, GLOBAL_FILE)).then(
      () => true,
      () => false,
    );
  }

  async writeDefaults(files: Readonly<Record<string, string>>): Promise<void> {
    for (const [file, text] of Object.entries(files)) {
      const path = this.inside(file);
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, text, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  async readRuleFiles(): Promise<RuleFileText[]> {
    const files: RuleFileText[] = [];
    const globalPath = this.inside(GLOBAL_FILE);
    const global = await readOptional(globalPath);
    if (global !== undefined) {
      files.push({ file: GLOBAL_FILE, path: globalPath, text: global });
    }
    const reposRoot = this.inside(REPOS_DIR);
    for (const path of await yamlFilesUnder(reposRoot)) {
      const text = await readOptional(path);
      if (text === undefined) continue;
      const rel = relative(reposRoot, path).split(sep).join("/");
      files.push({
        file: `${REPOS_DIR}/${rel}`,
        path,
        repositoryId: rel.replace(/\.ya?ml$/, ""),
        text,
      });
    }
    return files;
  }

  async importModule(relativePath: string): Promise<Record<string, unknown>> {
    const path = this.inside(relativePath);
    const { mtimeMs } = await stat(path);
    const url = `${pathToFileURL(path).href}?v=${Math.trunc(mtimeMs)}`;
    return (await import(url)) as Record<string, unknown>;
  }

  /** Resolve a rules-dir-relative path, refusing anything outside the dir. */
  private inside(relativePath: string): string {
    const root = resolve(this.dir);
    const path = resolve(root, relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`${relativePath} is outside the rules directory`);
    }
    return path;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function yamlFilesUnder(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await yamlFilesUnder(path)));
    else if (/\.ya?ml$/.test(entry.name)) files.push(path);
  }
  return files;
}
