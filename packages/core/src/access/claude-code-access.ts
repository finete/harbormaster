// Resource Access for the Claude Code harness (decision #18, R2): Claude's
// own files, read-only. Harbormaster never writes to Claude's config
// directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR`); hooks and the MCP server
// travel per session on the command line instead (see
// `harness/claude-code-adapter.ts`).
//
// - Model catalog: `claude` has no `--list-models`, so the list is a small
//   static set of the aliases and pinned ids the Claude Code docs name
//   (https://code.claude.com/docs/en/model-config, "Model aliases"; checked
//   2026-11-11). The default is Claude's own `model` user setting.
// - Transcripts: `<configDir>/projects/<project slug>/<sessionId>.jsonl`.
//   Only whether one exists for an id matters (a never-persisted session
//   cannot be `--resume`d, it is re-created under the same id instead).

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
} from "../contracts/harness.js";
import type { ThinkingLevel } from "../contracts/model.js";

/** Claude's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The static model list (Anthropic API aliases plus the pinned current
 * ids). `--model` accepts an alias or a full model name; an unknown value is
 * not rejected up front (the first request fails), so the list stays small
 * and documented rather than guessed. `thinking` = accepts `--effort`.
 */
export const CLAUDE_CODE_MODELS: readonly HarnessModel[] = [
  { id: "opus", provider: "aliases", name: "opus", thinking: true },
  { id: "sonnet", provider: "aliases", name: "sonnet", thinking: true },
  { id: "haiku", provider: "aliases", name: "haiku", thinking: false },
  { id: "fable", provider: "aliases", name: "fable", thinking: true },
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    name: "claude-opus-5-5",
    thinking: true,
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    name: "claude-sonnet-5-5",
    thinking: true,
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    name: "claude-haiku-5-5",
    thinking: false,
  },
];

/** Claude's `effortLevel` setting values, as Harbormaster thinking levels. */
const EFFORT_LEVELS = new Set<ThinkingLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type Catalog = Omit<HarnessModelCatalog, "harness" | "label">;

export interface ClaudeCodeAccessOptions {
  /** Claude's config directory; defaults to {@link claudeConfigDir}. */
  configDir?: string;
}

/** Static model list + Claude's own default model/effort from its user settings. */
export class ClaudeModelCatalogAccess implements HarnessModelCatalogAccess {
  constructor(private readonly options: ClaudeCodeAccessOptions = {}) {}

  async listModels(): Promise<Catalog> {
    return {
      models: CLAUDE_CODE_MODELS.map((model) => ({ ...model })),
      ...(await this.defaults()),
    };
  }

  async defaults(): Promise<Pick<Catalog, "defaultModel" | "defaultThinking">> {
    const dir = this.options.configDir ?? claudeConfigDir();
    let settings: unknown;
    try {
      settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    } catch {
      return {};
    }
    if (!settings || typeof settings !== "object") return {};
    const { model, effortLevel } = settings as Record<string, unknown>;
    return {
      ...(typeof model === "string" && model.trim() && model !== "default"
        ? { defaultModel: model.trim() }
        : {}),
      ...(typeof effortLevel === "string" &&
      EFFORT_LEVELS.has(effortLevel as ThinkingLevel)
        ? { defaultThinking: effortLevel as ThinkingLevel }
        : {}),
    };
  }
}

/** Whether Claude persisted a transcript for a session id (any project). */
export interface ClaudeTranscriptAccess {
  exists(sessionId: string): boolean;
}

/**
 * Looks for `<configDir>/projects/<any project>/<sessionId>.jsonl`. Any
 * project, because `claude --resume <id>` searches every project too (and
 * the project slug of a worktree path is Claude's business, not ours).
 */
export class LocalClaudeTranscriptAccess implements ClaudeTranscriptAccess {
  constructor(private readonly options: ClaudeCodeAccessOptions = {}) {}

  exists(sessionId: string): boolean {
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return false;
    const projects = join(
      this.options.configDir ?? claudeConfigDir(),
      "projects",
    );
    let dirs: string[];
    try {
      dirs = readdirSync(projects);
    } catch {
      return false;
    }
    return dirs.some((dir) =>
      existsSync(join(projects, dir, `${sessionId}.jsonl`)),
    );
  }
}
