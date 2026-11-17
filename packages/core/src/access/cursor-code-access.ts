// Resource Access for the Cursor CLI harness (docs/harness-additions.md
// C1-C9): Cursor's own files and its model list, read-only. Harbormaster
// never writes to Cursor's directories; hooks and the MCP server travel in
// a per-session plugin directory under Harbormaster's state dir (C2), which
// the launcher writes (`LaunchSpec.prepare`).
//
// Verified on cursor-agent 2026.11.13-eacade1 (its bundled sources and a
// real pty, 2026-11-17):
// - Config dir: `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else
//   `~/.cursor` (`cli-config.json`, `chats/`); data dir: `$CURSOR_DATA_DIR`,
//   else `~/.cursor` (`projects/`).
// - Transcript: `<data>/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`,
//   slug = the workspace path with every run of non-alphanumerics turned
//   into one "-" and leading/trailing "-" dropped
//   (`/private/tmp/hm-probe-0Etk/cursor-wt1` →
//   `private-tmp-hm-probe-0Etk-cursor-wt1`). Written when the first turn
//   ends (an idle, never-prompted chat has none). The workspace is the
//   real path (`process.cwd()`).
// - Chat store: `<config>/chats/<md5(workspace)>/<id>/store.db`, created
//   with the chat (before any prompt); `--resume=<id>` reopens it.
// - Model list: `agent --list-models` prints `Available models`, a blank
//   line, then `<id> - <name>` lines (the account's default carries
//   ` (current, default)`; some names end in zero-width spaces). Logged out
//   it prints `Error: Authentication required. …` on stderr (exit 1).
// - Default model: `cli-config.json` `model` (`{ modelId: "default",
//   displayModelId: "auto", aliases: ["auto"] }` for Auto).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type {
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelCatalogAccess,
} from "../contracts/harness.js";
import { canonicalPath } from "../utilities/canonical-path.js";
import { runOutcome } from "../utilities/run.js";

type Catalog = Omit<HarnessModelCatalog, "harness" | "label">;

/** Cursor's config dir: `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`. */
export function cursorConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env.CURSOR_CONFIG_DIR?.trim()) return env.CURSOR_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME, "cursor");
  return join(home, ".cursor");
}

/** Cursor's data dir (`projects/`): `$CURSOR_DATA_DIR`, else `~/.cursor`. */
export function cursorDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.CURSOR_DATA_DIR?.trim()
    ? env.CURSOR_DATA_DIR
    : join(home, ".cursor");
}

/** Cursor's project folder name for a workspace path (its `workspace-paths` slug). */
export function cursorProjectSlug(workspace: string): string {
  return workspace
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `<data>/projects/<slug>/agent-transcripts/<id>`: the folder a chat's transcript lives in. */
export function cursorTranscriptDir(
  dataDir: string,
  workspace: string,
  sessionId: string,
): string {
  return join(
    dataDir,
    "projects",
    cursorProjectSlug(workspace),
    "agent-transcripts",
    sessionId,
  );
}

/** `<data>/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` (written when the first turn ends). */
export function cursorTranscriptPath(
  dataDir: string,
  workspace: string,
  sessionId: string,
): string {
  return join(
    cursorTranscriptDir(dataDir, workspace, sessionId),
    `${sessionId}.jsonl`,
  );
}

/** A Cursor chat id: lowercase-hex UUID. */
const CHAT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The chat id a transcript path belongs to (`…/agent-transcripts/<id>/<id>.jsonl`); `undefined` for any other path. */
export function cursorSessionIdFromPath(path: string): string | undefined {
  const name = basename(path).replace(/\.jsonl$/, "");
  if (!CHAT_ID.test(name) || basename(dirname(path)) !== name) {
    return undefined;
  }
  return name.toLowerCase();
}

/** SGR color escapes (`ESC [ … m`). */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Zero-width characters some model names carry. */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

/** Parses `--list-models` output (pure): one `HarnessModel` per `<id> - <name>` line, plus the line marked `(current…)` / `(…default)`. */
export function parseCursorModelList(output: string): {
  models: HarnessModel[];
  current?: string;
} {
  const models: HarnessModel[] = [];
  let current: string | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(ANSI_SGR, "").replace(ZERO_WIDTH, "").trim();
    const match = /^([A-Za-z0-9][\w.:[\]=,/-]*) - (.+)$/.exec(line);
    if (!match) continue;
    const id = match[1] as string;
    let name = (match[2] as string).trim();
    const marker = /\s*\(([^)]*)\)\s*$/.exec(name);
    if (marker && /\b(current|default)\b/.test(marker[1] ?? "")) {
      current ??= id;
      name = name.slice(0, marker.index).trim();
    }
    models.push({
      id,
      provider: "cursor",
      name: name.replace(/\s+/g, " "),
      thinking: false,
    });
  }
  return { models, ...(current ? { current } : {}) };
}

/** Cursor's message when logged out (`--list-models`, `-p`, the TUI). */
export const CURSOR_AUTH_REQUIRED = "Authentication required";

export interface CursorAccessOptions {
  /** The command `--list-models` runs (the launch command); absent = the Cursor lookup. */
  command?: () => string[] | undefined;
  /** Cursor's config dir; defaults to {@link cursorConfigDir}. */
  configDir?: string;
  /** Cursor's data dir; defaults to {@link cursorDataDir}. */
  dataDir?: string;
  now?: () => number;
}

const LIST_TIMEOUT_MS = 15_000;
const NOT_LOGGED_IN =
  "Cursor is not logged in (run `agent login`); its default model is used.";
const CACHE_TTL_MS = 10 * 60_000;

/** Models from `agent --list-models` (when logged in) + the `cli-config.json` default. */
export class CursorModelCatalogAccess implements HarnessModelCatalogAccess {
  private cache: { at: number; catalog: Catalog } | undefined;

  constructor(private readonly options: CursorAccessOptions = {}) {}

  private get configDir(): string {
    return this.options.configDir ?? cursorConfigDir();
  }

  async listModels(): Promise<Catalog> {
    const now = this.options.now ?? Date.now;
    const cached = this.cache;
    if (cached && now() - cached.at < CACHE_TTL_MS) {
      return structuredClone(cached.catalog);
    }
    const defaults = await this.defaults();
    const argv = this.options.command?.() ?? resolveCursorCommand();
    const [command, ...prefix] = argv ?? [];
    if (!command) {
      return { models: [], ...defaults, error: "Cursor CLI not found" };
    }
    const outcome = await runOutcome(command, [...prefix, "--list-models"], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const said = `${outcome.stdout}\n${outcome.stderr}`;
    if (said.includes(CURSOR_AUTH_REQUIRED)) {
      return { models: [], ...defaults, error: NOT_LOGGED_IN };
    }
    if (!outcome.ok) {
      const why = outcome.notFound
        ? "not found"
        : outcome.timedOut
          ? "timed out"
          : said.trim().split("\n")[0] || `exit ${outcome.exitCode ?? "?"}`;
      return {
        models: [],
        ...defaults,
        error: `Could not list Cursor models: ${why}`,
      };
    }
    const output = outcome.stdout;
    const parsed = parseCursorModelList(output);
    const catalog: Catalog = {
      models: parsed.models,
      ...(defaults.defaultModel
        ? defaults
        : parsed.current
          ? { defaultModel: parsed.current }
          : {}),
    };
    this.cache = { at: now(), catalog };
    return structuredClone(catalog);
  }

  async defaults(): Promise<Pick<Catalog, "defaultModel" | "defaultThinking">> {
    let config: unknown;
    try {
      config = JSON.parse(
        readFileSync(join(this.configDir, "cli-config.json"), "utf8"),
      );
    } catch {
      return {};
    }
    const model = (config as { model?: Record<string, unknown> })?.model;
    if (!model || typeof model !== "object") return {};
    const aliases = Array.isArray(model.aliases) ? model.aliases : [];
    const pick = [aliases[0], model.displayModelId, model.modelId].find(
      (value): value is string => typeof value === "string" && !!value.trim(),
    );
    return pick ? { defaultModel: pick } : {};
  }
}

/** Whether Cursor has a chat to `--resume` (its transcript or its chat store). */
export interface CursorTranscriptAccess {
  exists(workspace: string, sessionId: string): boolean;
}

/** Looks for the transcript (`<data>/projects/…`) or the chat store (`<config>/chats/<md5(workspace)>/<id>`). */
export class LocalCursorTranscriptAccess implements CursorTranscriptAccess {
  constructor(private readonly options: CursorAccessOptions = {}) {}

  exists(workspace: string, sessionId: string): boolean {
    if (!CHAT_ID.test(sessionId)) return false;
    const data = this.options.dataDir ?? cursorDataDir();
    const config = this.options.configDir ?? cursorConfigDir();
    const real = canonicalPath(workspace);
    for (const path of new Set([real, resolve(workspace)])) {
      if (existsSync(cursorTranscriptPath(data, path, sessionId))) return true;
      const hash = createHash("md5").update(path).digest("hex");
      if (existsSync(join(config, "chats", hash, sessionId))) return true;
    }
    return false;
  }
}

/**
 * Whether the executable at `path` is Cursor's CLI without running it:
 * Cursor's installer links `agent` and `cursor-agent` to
 * `…/cursor-agent/versions/<version>/cursor-agent`, so the resolved file
 * is named `cursor-agent` (or sits in a `cursor-agent` tree). A generic
 * `agent` that resolves anywhere else is another program (C6).
 */
export function isCursorAgentBinary(path: string): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return (
    basename(real) === "cursor-agent" || /[/\\]cursor-agent[/\\]/.test(real)
  );
}

function executableOnPath(
  binary: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/**
 * The argv prefix that runs Cursor's CLI, in C6's lookup order: `agent`
 * (only when it resolves to Cursor's binary), `cursor-agent`, `cursor
 * agent` (the IDE's CLI subcommand); `undefined` when none is on PATH.
 * Skips terminal-multiplexer shims via `isShim`.
 */
export function resolveCursorCommand(
  env: NodeJS.ProcessEnv = process.env,
  isShim: (path: string) => boolean = () => false,
): string[] | undefined {
  const agent = executableOnPath("agent", env);
  if (agent && !isShim(agent) && isCursorAgentBinary(agent)) return ["agent"];
  const legacy = executableOnPath("cursor-agent", env);
  if (legacy && !isShim(legacy)) return ["cursor-agent"];
  const ide = executableOnPath("cursor", env);
  if (ide && !isShim(ide)) return ["cursor", "agent"];
  return undefined;
}
