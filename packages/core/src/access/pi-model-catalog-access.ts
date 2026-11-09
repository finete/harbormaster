// Resource Access: Pi's model catalog for the composer's Agent · Model
// picker (see /docs/new-task-composer.md). Runs `pi --list-models` (only
// providers the user is logged into) and reads Pi's own startup defaults
// from its settings file. Cached briefly: the picker asks every time a draft
// opens, and the CLI takes a moment to start.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
} from "../contracts/harness.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../contracts/model.js";
import { run } from "../utilities/run.js";

const CACHE_TTL_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 10_000;

export interface PiModelCatalogAccessOptions {
  /**
   * The binary to run `--list-models` with. Defaults to
   * `$HARBORMASTER_PI_LIST_MODELS_COMMAND`, else `pi` -- but never the e2e
   * fake `$HARBORMASTER_PI_COMMAND` (those idle forever): with only that set,
   * the list comes back empty instead.
   */
  command?: string;
  /** Pi's settings file; defaults to `$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`. */
  settingsPath?: string;
  now?: () => number;
}

type Catalog = Omit<HarnessModelCatalog, "harness" | "label">;

/**
 * Parse `pi --list-models`' table: a header row (`provider model context
 * max-out thinking images`), then one whitespace-separated row per model.
 * Rows that don't fit are skipped, never fatal.
 */
export function parsePiModelList(output: string): HarnessModel[] {
  const models: HarnessModel[] = [];
  for (const line of output.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 2 || cells[0] === "provider") continue;
    const [provider, name, , , thinking] = cells as [
      string,
      string,
      string?,
      string?,
      string?,
    ];
    models.push({
      id: `${provider}/${name}`,
      provider,
      name,
      thinking: thinking === "yes",
    });
  }
  return models;
}

export class PiModelCatalogAccess implements HarnessModelCatalogAccess {
  private cache: { at: number; catalog: Catalog } | undefined;
  private readonly now: () => number;

  constructor(private readonly options: PiModelCatalogAccessOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async listModels(): Promise<Catalog> {
    const cached = this.cache;
    if (cached && this.now() - cached.at < CACHE_TTL_MS) {
      return structuredClone(cached.catalog);
    }
    const defaults = await this.readDefaults();
    const command = this.command();
    if (!command) {
      return { models: [], ...defaults, error: "Model list unavailable" };
    }
    let catalog: Catalog;
    try {
      const stdout = await run(command, ["--list-models"], undefined, {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      catalog = { models: parsePiModelList(stdout), ...defaults };
    } catch (error) {
      // Not cached: a missing/broken pi should be retried next time.
      return {
        models: [],
        ...defaults,
        error: `Could not list Pi models: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.cache = { at: this.now(), catalog };
    return structuredClone(catalog);
  }

  private command(): string | undefined {
    if (this.options.command) return this.options.command;
    if (process.env.HARBORMASTER_PI_LIST_MODELS_COMMAND) {
      return process.env.HARBORMASTER_PI_LIST_MODELS_COMMAND;
    }
    return process.env.HARBORMASTER_PI_COMMAND ? undefined : "pi";
  }

  private async readDefaults(): Promise<
    Pick<Catalog, "defaultModel" | "defaultThinking">
  > {
    const path =
      this.options.settingsPath ??
      join(
        process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
        "settings.json",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return {};
    }
    if (!raw || typeof raw !== "object") return {};
    const settings = raw as Record<string, unknown>;
    const model =
      typeof settings.defaultModel === "string"
        ? settings.defaultModel
        : undefined;
    const provider =
      typeof settings.defaultProvider === "string"
        ? settings.defaultProvider
        : undefined;
    const thinking = THINKING_LEVELS.includes(
      settings.defaultThinkingLevel as ThinkingLevel,
    )
      ? (settings.defaultThinkingLevel as ThinkingLevel)
      : undefined;
    return {
      ...(model
        ? {
            defaultModel:
              provider && !model.includes("/") ? `${provider}/${model}` : model,
          }
        : {}),
      ...(thinking ? { defaultThinking: thinking } : {}),
    };
  }
}
