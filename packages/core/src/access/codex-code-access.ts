// Resource Access for the Codex CLI harness (docs/harness-additions.md
// X1-X11): Codex's own files, read-only. Harbormaster never writes to
// Codex's home (`$CODEX_HOME`, else `~/.codex`); hooks and the MCP server
// travel per session as `-c` overrides (see `harness/codex-adapter.ts`).
// Codex itself writes the folder-trust entry into its `config.toml` when
// the user trusts a worktree (X8).
//
// Verified on disk, codex-cli 0.169.0 (2026-11-17):
// - Model catalog: `<home>/models_cache.json` (`{ fetched_at, client_version,
//   models: [{ slug, display_name, visibility: "list" | "hide",
//   supported_reasoning_levels: [{ effort }], default_reasoning_level }] }`),
//   written by Codex after it fetched the list once. The defaults are the
//   top-level `model` / `model_reasoning_effort` keys of `<home>/config.toml`.
// - Transcripts ("rollouts"): `<home>/sessions/YYYY/MM/DD/rollout-<local
//   timestamp>-<session id>.jsonl`, created when the session starts (before
//   any prompt). The id is a UUID (v7).

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
} from "../contracts/harness.js";
import type { ThinkingLevel } from "../contracts/model.js";

/** Codex's home: `$CODEX_HOME`, else `~/.codex`. */
export function codexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.CODEX_HOME || join(home, ".codex");
}

/** `rollout-<ts>-<uuid>.jsonl` → the session id (the trailing UUID). */
const ROLLOUT_NAME =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The session id a rollout file belongs to, from its name; `undefined` for any other file. */
export function codexSessionIdFromPath(path: string): string | undefined {
  return ROLLOUT_NAME.exec(basename(path))?.[1]?.toLowerCase();
}

/** Codex's reasoning efforts that are Harbormaster thinking levels. */
const EFFORTS = new Set<ThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type Catalog = Omit<HarnessModelCatalog, "harness" | "label">;

/**
 * The top-level `key = "value"` string of a TOML document (before its
 * first table header), enough for `model` / `model_reasoning_effort`. Not a
 * TOML parser: anything fancier (a multi-line string) reads as absent.
 */
export function topLevelTomlString(
  toml: string,
  key: string,
): string | undefined {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) return undefined;
    const match = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]?.replace(/^"|"$/g, "");
    if (name !== key) continue;
    const value = match[2]?.trim() ?? "";
    const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value);
    if (!quoted) return undefined;
    return quoted[1] !== undefined
      ? quoted[1].replace(/\\(["\\])/g, "$1")
      : quoted[2];
  }
  return undefined;
}

export interface CodexAccessOptions {
  /** Codex's home; defaults to {@link codexHomeDir}. */
  homeDir?: string;
}

/** Models from Codex's own cache + its `config.toml` defaults; never spawns Codex. */
export class CodexModelCatalogAccess implements HarnessModelCatalogAccess {
  constructor(private readonly options: CodexAccessOptions = {}) {}

  private get home(): string {
    return this.options.homeDir ?? codexHomeDir();
  }

  async listModels(): Promise<Catalog> {
    const defaults = await this.defaults();
    let cache: unknown;
    try {
      cache = JSON.parse(
        await readFile(join(this.home, "models_cache.json"), "utf8"),
      );
    } catch {
      return {
        models: [],
        ...defaults,
        error:
          "Codex has not cached its model list yet (start Codex once); its default model is used.",
      };
    }
    const list = (cache as { models?: unknown })?.models;
    const models: HarnessModel[] = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const model = entry as Record<string, unknown>;
      if (typeof model.slug !== "string" || !model.slug) continue;
      if (model.visibility !== undefined && model.visibility !== "list")
        continue;
      const levels = model.supported_reasoning_levels;
      models.push({
        id: model.slug,
        provider: "openai",
        name: model.slug,
        thinking: Array.isArray(levels) && levels.length > 0,
      });
    }
    return { models, ...defaults };
  }

  async defaults(): Promise<Pick<Catalog, "defaultModel" | "defaultThinking">> {
    let toml: string;
    try {
      toml = await readFile(join(this.home, "config.toml"), "utf8");
    } catch {
      return {};
    }
    const model = topLevelTomlString(toml, "model")?.trim();
    const effort = topLevelTomlString(toml, "model_reasoning_effort")?.trim();
    return {
      ...(model ? { defaultModel: model } : {}),
      ...(effort && EFFORTS.has(effort as ThinkingLevel)
        ? { defaultThinking: effort as ThinkingLevel }
        : {}),
    };
  }
}

/** Whether Codex persisted a rollout for a session id (`codex resume <id>` needs one). */
export interface CodexTranscriptAccess {
  exists(sessionId: string): boolean;
}

/** Looks for `<home>/sessions/<y>/<m>/<d>/rollout-*-<id>.jsonl`. */
export class LocalCodexTranscriptAccess implements CodexTranscriptAccess {
  constructor(private readonly options: CodexAccessOptions = {}) {}

  exists(sessionId: string): boolean {
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return false;
    const suffix = `-${sessionId.toLowerCase()}.jsonl`;
    const root = join(this.options.homeDir ?? codexHomeDir(), "sessions");
    const list = (dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    };
    // Newest first: a resumed session is usually recent.
    for (const year of list(root).sort().reverse()) {
      for (const month of list(join(root, year)).sort().reverse()) {
        for (const day of list(join(root, year, month))
          .sort()
          .reverse()) {
          const dir = join(root, year, month, day);
          if (
            list(dir).some(
              (name) =>
                name.startsWith("rollout-") &&
                name.toLowerCase().endsWith(suffix),
            )
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }
}
