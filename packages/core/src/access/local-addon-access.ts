// Resource Access: user addons under `<stateDir>/addons/<name>/` —
// `addon.json` (manifest), `source.mjs` (the sources it provides) and an
// optional suggested-rules YAML the manifest names. Discovery never
// throws: each addon's read/import errors are reported on it, so one broken
// addon never blocks the others. No sandbox: an addon runs with the app's
// privileges (documented in docs/release-plan.md "Addons").

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddonAccess, DiscoveredAddon } from "../contracts/rules.js";

export class LocalAddonAccess implements AddonAccess {
  constructor(private readonly dir: string) {}

  async discover(): Promise<DiscoveredAddon[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const addons: DiscoveredAddon[] = [];
    for (const dirName of names) addons.push(await this.load(dirName));
    return addons;
  }

  private async load(dirName: string): Promise<DiscoveredAddon> {
    const root = join(this.dir, dirName);
    const addon: DiscoveredAddon = { dirName, problems: [] };
    try {
      addon.manifest = JSON.parse(
        await readFile(join(root, "addon.json"), "utf8"),
      );
    } catch (error) {
      addon.problems.push(`addon.json: ${describe(error)}`);
      return addon;
    }
    const sourcePath = join(root, "source.mjs");
    const hasSource = await stat(sourcePath).then(
      (info) => info.isFile(),
      () => false,
    );
    if (hasSource) {
      try {
        const { mtimeMs } = await stat(sourcePath);
        addon.module = (await import(
          `${pathToFileURL(sourcePath).href}?v=${Math.trunc(mtimeMs)}`
        )) as Record<string, unknown>;
      } catch (error) {
        addon.problems.push(`source.mjs: ${describe(error)}`);
      }
    }
    const rulesFile = (
      addon.manifest as { provides?: { rules?: unknown } } | undefined
    )?.provides?.rules;
    if (typeof rulesFile === "string") {
      const path = resolve(root, rulesFile);
      if (!path.startsWith(`${resolve(root)}${sep}`)) {
        addon.problems.push(`provides.rules points outside the addon`);
      } else {
        try {
          addon.suggestedRules = await readFile(path, "utf8");
        } catch (error) {
          addon.problems.push(`${rulesFile}: ${describe(error)}`);
        }
      }
    }
    return addon;
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}
