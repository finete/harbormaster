// Engine: validate addons found under `<stateDir>/addons/<name>/`
// (`addon.json` + `source.mjs`). A broken addon (bad manifest, module that
// fails to load, a source that is not what it declares) is skipped with a
// problem, never fatal; an addon may not shadow a built-in (or an earlier
// addon's) source or awaiting-kind id. Suggested rules are only reported,
// never activated. Pure: discovery/import is AddonAccess's job.

import type {
  AddonAwaitingKind,
  AddonInfo,
  DiscoveredAddon,
  Source,
} from "../../contracts/rules.js";

export interface ValidatedAddons {
  /** Sources from addons that loaded, in discovery order. */
  sources: Source[];
  infos: AddonInfo[];
  /** One line per skipped addon / problem, for warnings. */
  problems: string[];
}

export function validateAddons(
  discovered: readonly DiscoveredAddon[],
  reservedSourceIds: ReadonlySet<string>,
  reservedKindIds: ReadonlySet<string>,
): ValidatedAddons {
  const sources: Source[] = [];
  const infos: AddonInfo[] = [];
  const problems: string[] = [];
  const takenSources = new Set(reservedSourceIds);
  const takenKinds = new Set(reservedKindIds);

  for (const addon of discovered) {
    const result = validateOne(addon, takenSources, takenKinds);
    infos.push(result.info);
    if (result.info.loaded) {
      for (const source of result.sources) {
        takenSources.add(source.id);
        sources.push(source);
      }
      for (const kind of result.info.awaitingKinds) takenKinds.add(kind.id);
    } else {
      problems.push(
        `Addon ${result.info.name} skipped: ${result.info.problems.join("; ")}`,
      );
    }
  }
  return { sources, infos, problems };
}

function validateOne(
  addon: DiscoveredAddon,
  takenSources: ReadonlySet<string>,
  takenKinds: ReadonlySet<string>,
): { info: AddonInfo; sources: Source[] } {
  const problems = [...addon.problems];
  const manifest = isRecord(addon.manifest) ? addon.manifest : undefined;
  if (!manifest && addon.problems.length === 0) {
    problems.push("addon.json is not an object");
  }
  const name =
    typeof manifest?.name === "string" && manifest.name.trim()
      ? manifest.name.trim()
      : addon.dirName;
  const version =
    typeof manifest?.version === "string" ? manifest.version : "0.0.0";
  if (manifest && typeof manifest.version !== "string") {
    problems.push("addon.json version must be a string");
  }
  const provides = isRecord(manifest?.provides) ? manifest.provides : {};
  if (manifest && !isRecord(manifest.provides)) {
    problems.push("addon.json provides must be an object");
  }

  const declaredSources = stringList(
    provides.sources,
    "provides.sources",
    problems,
  );
  const awaitingKinds = kindList(provides.awaitingKinds, problems);
  for (const kind of awaitingKinds) {
    if (takenKinds.has(kind.id)) {
      problems.push(`awaiting kind "${kind.id}" shadows an existing kind`);
    }
  }

  const exported = exportedSources(addon.module, problems);
  const sources: Source[] = [];
  for (const id of declaredSources) {
    if (takenSources.has(id)) {
      problems.push(`source "${id}" shadows an existing source`);
      continue;
    }
    const source = exported.find((candidate) => candidate.id === id);
    if (!source) {
      problems.push(`source.mjs does not export source "${id}"`);
      continue;
    }
    if (
      typeof source.snapshot !== "function" &&
      typeof source.subscribe !== "function"
    ) {
      problems.push(`source "${id}" has neither snapshot() nor subscribe()`);
      continue;
    }
    if (
      source.interval !== undefined &&
      (typeof source.interval !== "number" || source.interval < 0)
    ) {
      problems.push(`source "${id}" interval must be a non-negative number`);
      continue;
    }
    sources.push(source);
  }
  for (const source of exported) {
    if (!declaredSources.includes(source.id)) {
      problems.push(
        `source.mjs exports undeclared source "${source.id}" (list it in provides.sources)`,
      );
    }
  }

  const loaded = problems.length === 0;
  return {
    info: {
      name,
      version,
      ...(typeof manifest?.description === "string"
        ? { description: manifest.description }
        : {}),
      builtin: false,
      readOnly: false,
      sources: sources.map((source) => ({
        id: source.id,
        ...(source.interval !== undefined ? { interval: source.interval } : {}),
        ...(source.settingsSchema
          ? { settingsSchema: source.settingsSchema }
          : {}),
      })),
      awaitingKinds,
      ...(addon.suggestedRules !== undefined
        ? { suggestedRules: addon.suggestedRules }
        : {}),
      loaded,
      problems,
    },
    sources: loaded ? sources : [],
  };
}

/** `export default source | [sources]`, `export const sources = [...]`, or `export const source`. */
function exportedSources(
  module: Record<string, unknown> | undefined,
  problems: string[],
): Source[] {
  if (!module) return [];
  const candidates: unknown[] = [];
  for (const key of ["default", "sources", "source"]) {
    const value = module[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) candidates.push(...value);
    else candidates.push(value);
  }
  const sources: Source[] = [];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.id === "string") {
      if (!sources.some((source) => source.id === candidate.id)) {
        sources.push(candidate as unknown as Source);
      }
    } else {
      problems.push("source.mjs exports something that is not a source");
    }
  }
  return sources;
}

function stringList(value: unknown, at: string, problems: string[]): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    problems.push(`${at} must be a list of non-empty strings`);
    return [];
  }
  return value as string[];
}

function kindList(value: unknown, problems: string[]): AddonAwaitingKind[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("provides.awaitingKinds must be a list");
    return [];
  }
  const kinds: AddonAwaitingKind[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.label !== "string"
    ) {
      problems.push("provides.awaitingKinds entries need an id and a label");
      continue;
    }
    kinds.push({
      id: entry.id,
      label: entry.label,
      ...(typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
    });
  }
  return kinds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
