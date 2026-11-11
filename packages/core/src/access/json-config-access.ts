// Resource Access: per-user global config file. Simplified from pi-home's
// src/access/global-config-access.ts — repositories/headless-model fields
// are GitHub/addon concerns that return with those phases; the automation
// kill switch survives (board automation itself is the rules engine), and phase 2b
// adds back codeRoot/branchPrefix (see contracts/workspace.ts) now that git
// repository/worktree access needs them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CustomAgentConfig,
  DeploymentPipeline,
  DeploymentStageConfig,
  GlobalConfig,
  RepositoryConfig,
  SourceConfig,
} from "../contracts/model.js";
import { defaultGlobalConfig } from "../contracts/model.js";
import type { ConfigAccess, LegacyMoverOrders } from "../contracts/services.js";
// Imported for its side-effecting declare-module augmentation of
// GlobalConfig (codeRoot/branchPrefix) — contracts/workspace.ts owns those
// fields' types.
import "../contracts/workspace.js";
import { writeJsonAtomic } from "../utilities/atomic-json.js";

export class JsonConfigAccess implements ConfigAccess {
  constructor(private readonly path: string) {}

  async load(): Promise<GlobalConfig> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw this.invalid(error);
      const config: GlobalConfig = {
        ...defaultGlobalConfig(),
        codeRoot: normalizeCodeRoot(undefined),
        branchPrefix: normalizeBranchPrefix(undefined),
      };
      await mkdir(dirname(this.path), { recursive: true });
      try {
        await writeFile(this.path, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (writeError) {
        // Another process may have created the config concurrently.
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
          throw writeError;
      }
      return config;
    }
    if (!isRecord(raw)) throw this.invalid();
    try {
      const repositories = normalizeRepositories(raw.repositories);
      const launch = normalizeLaunch(raw.launch);
      const messaging = normalizeMessaging(raw.messaging);
      const sources = normalizeSources(raw.sources);
      const agents = normalizeAgents(raw.agents);
      return {
        automation: normalizeAutomation(raw.automation),
        ...(sources ? { sources } : {}),
        codeRoot: normalizeCodeRoot(raw.codeRoot),
        branchPrefix: normalizeBranchPrefix(raw.branchPrefix),
        ...(repositories ? { repositories } : {}),
        ...(launch ? { launch } : {}),
        ...(messaging ? { messaging } : {}),
        ...(agents ? { agents } : {}),
      };
    } catch (error) {
      throw this.invalid(error);
    }
  }

  async save(config: GlobalConfig): Promise<void> {
    await writeJsonAtomic(this.path, config);
  }

  /**
   * The retired `movers` lists of a pre-rules config (global and per
   * repository), read once to migrate them into the first `rules.yaml`.
   * The live config ignores them.
   */
  async legacyMoverOrders(): Promise<LegacyMoverOrders> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return { repositories: {} };
    }
    if (!isRecord(raw)) return { repositories: {} };
    const legacy: LegacyMoverOrders = { repositories: {} };
    const global = legacyMovers(raw.movers);
    if (global) legacy.global = global;
    if (isRecord(raw.repositories)) {
      for (const [id, entry] of Object.entries(raw.repositories)) {
        const movers = isRecord(entry) ? legacyMovers(entry.movers) : undefined;
        if (movers) legacy.repositories[id] = movers;
      }
    }
    return legacy;
  }

  private invalid(cause?: unknown): Error {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    return new Error(`Invalid Harbormaster config at ${this.path}${detail}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Per-repository settings, keyed by normalized repository id. Validated
 * leniently: only the `deployment` shape this phase reads is checked;
 * unrecognized keys on a repository entry (and opaque per-stage `options`)
 * round-trip untouched so a later phase (or a user hand-editing the file)
 * can add fields without this loader rejecting the whole config.
 */
function normalizeRepositories(
  value: unknown,
): Record<string, RepositoryConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("repositories must be an object keyed by repository id");
  }
  const repositories: Record<string, RepositoryConfig> = {};
  for (const [repositoryId, entry] of Object.entries(value)) {
    if (!repositoryId.trim()) {
      throw new Error("repositories keys must be non-empty repository ids");
    }
    if (!isRecord(entry)) {
      throw new Error(`repositories.${repositoryId} must be an object`);
    }
    const config: RepositoryConfig = { ...entry } as RepositoryConfig;
    if (entry.deployment !== undefined) {
      config.deployment = normalizeDeployment(repositoryId, entry.deployment);
    }
    // Retired: `movers` was migrated into rules files (see legacyMoverOrders).
    delete (config as { movers?: unknown }).movers;
    const preferredCheckout = normalizePreferredCheckout(
      repositoryId,
      entry.preferredCheckout,
    );
    if (preferredCheckout) config.preferredCheckout = preferredCheckout;
    else delete config.preferredCheckout;
    if (entry.defaultHarness !== undefined) {
      config.defaultHarness = normalizeHarnessId(
        `repositories.${repositoryId}.defaultHarness`,
        entry.defaultHarness,
      );
    }
    if (entry.bypassPermissions !== undefined) {
      config.bypassPermissions = normalizeBoolean(
        `repositories.${repositoryId}.bypassPermissions`,
        entry.bypassPermissions,
      );
    }
    repositories[repositoryId] = config;
  }
  return repositories;
}

/**
 * Validated leniently: only the type is checked (a non-empty string once
 * trimmed, else dropped). Whether the path is actually a discoverable,
 * non-linked-worktree checkout of this repository is a
 * `GitRepositoryAccess.discoverRepositories` concern at discovery time, not
 * a config-load concern (git access is out of scope here).
 */
function normalizePreferredCheckout(
  repositoryId: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `repositories.${repositoryId}.preferredCheckout must be a string`,
    );
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeDeployment(
  repositoryId: string,
  value: unknown,
): DeploymentPipeline {
  const at = `repositories.${repositoryId}.deployment`;
  if (!isRecord(value)) throw new Error(`${at} must be an object`);
  if (
    value.releaseBranch !== undefined &&
    (typeof value.releaseBranch !== "string" || !value.releaseBranch.trim())
  ) {
    throw new Error(`${at}.releaseBranch must be a non-empty string`);
  }
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    throw new Error(`${at}.stages must be a non-empty array`);
  }
  const seen = new Set<string>();
  const stages = value.stages.map((stage, index): DeploymentStageConfig => {
    const stageAt = `${at}.stages[${index}]`;
    if (!isRecord(stage)) throw new Error(`${stageAt} must be an object`);
    if (
      typeof stage.id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(stage.id)
    ) {
      throw new Error(`${stageAt}.id must be an alphanumeric identifier`);
    }
    if (seen.has(stage.id)) {
      throw new Error(`${at}.stages has a duplicate id "${stage.id}"`);
    }
    seen.add(stage.id);
    if (
      stage.label !== undefined &&
      (typeof stage.label !== "string" || !stage.label.trim())
    ) {
      throw new Error(`${stageAt}.label must be a non-empty string`);
    }
    if (
      stage.hook !== undefined &&
      (typeof stage.hook !== "string" || !stage.hook.trim())
    ) {
      throw new Error(`${stageAt}.hook must be a hook name`);
    }
    if (stage.options !== undefined && !isRecord(stage.options)) {
      throw new Error(`${stageAt}.options must be an object`);
    }
    // pi-home parity: options only ever reach a hook, so options on a
    // manual (hookless) stage are a config mistake, rejected at load.
    if (stage.options !== undefined && stage.hook === undefined) {
      throw new Error(`${stageAt}.options requires a hook`);
    }
    return {
      id: stage.id,
      label: typeof stage.label === "string" ? stage.label.trim() : stage.id,
      ...(stage.hook ? { hook: stage.hook } : {}),
      // Opaque per-stage options (e.g. version-endpoint's url/hotfixScan/
      // hotfixDepth) are preserved verbatim: hooks own their own validation.
      ...(stage.options
        ? { options: stage.options as Record<string, unknown> }
        : {}),
    };
  });
  return {
    ...(value.releaseBranch
      ? { releaseBranch: value.releaseBranch.trim() }
      : {}),
    stages,
  };
}

/**
 * Validated leniently like the rest of this file: `maxConcurrent` a positive
 * integer, `defaultModel` a non-empty string, both optional. Unset
 * `maxConcurrent` defaults at read time (`DEFAULT_LAUNCH_MAX_CONCURRENT`),
 * not here, so the default can change without a config rewrite.
 */
function normalizeLaunch(value: unknown): GlobalConfig["launch"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("launch must be an object");
  const launch: NonNullable<GlobalConfig["launch"]> = {};
  if (value.maxConcurrent !== undefined) {
    if (
      typeof value.maxConcurrent !== "number" ||
      !Number.isInteger(value.maxConcurrent) ||
      value.maxConcurrent <= 0
    ) {
      throw new Error("launch.maxConcurrent must be a positive integer");
    }
    launch.maxConcurrent = value.maxConcurrent;
  }
  if (value.defaultModel !== undefined) {
    if (typeof value.defaultModel !== "string" || !value.defaultModel.trim()) {
      throw new Error("launch.defaultModel must be a non-empty string");
    }
    launch.defaultModel = value.defaultModel.trim();
  }
  if (value.defaultHarness !== undefined) {
    launch.defaultHarness = normalizeHarnessId(
      "launch.defaultHarness",
      value.defaultHarness,
    );
  }
  if (value.bypassPermissions !== undefined) {
    launch.bypassPermissions = normalizeBoolean(
      "launch.bypassPermissions",
      value.bypassPermissions,
    );
  }
  return launch;
}

function normalizeHarnessId(at: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${at} must be a non-empty agent id`);
  }
  return value.trim();
}

function normalizeBoolean(at: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${at} must be a boolean`);
  return value;
}

/**
 * `agents.custom[]`: user-configured "any CLI" agents. Each needs an `id`,
 * a `label` and a `command`; `args` is a string array; `promptArg` is
 * `"positional"` or `"none"`.
 */
function normalizeAgents(value: unknown): GlobalConfig["agents"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("agents must be an object");
  if (value.custom === undefined) return {};
  if (!Array.isArray(value.custom)) {
    throw new Error("agents.custom must be an array");
  }
  const custom = value.custom.map((entry, index): CustomAgentConfig => {
    const at = `agents.custom[${index}]`;
    if (!isRecord(entry)) throw new Error(`${at} must be an object`);
    const text = (key: string): string => {
      const field = entry[key];
      if (typeof field !== "string" || !field.trim()) {
        throw new Error(`${at}.${key} must be a non-empty string`);
      }
      return field.trim();
    };
    const agent: CustomAgentConfig = {
      id: text("id"),
      label: text("label"),
      command: text("command"),
    };
    if (entry.args !== undefined) {
      if (
        !Array.isArray(entry.args) ||
        entry.args.some((arg) => typeof arg !== "string")
      ) {
        throw new Error(`${at}.args must be an array of strings`);
      }
      agent.args = [...(entry.args as string[])];
    }
    if (entry.promptArg !== undefined) {
      if (entry.promptArg !== "positional" && entry.promptArg !== "none") {
        throw new Error(`${at}.promptArg must be "positional" or "none"`);
      }
      agent.promptArg = entry.promptArg;
    }
    return agent;
  });
  return { custom };
}

/**
 * Validated leniently like `launch`: both fields optional; defaults
 * (`DEFAULT_PARENT_REPLY_TIMEOUT_MINUTES` / `DEFAULT_MESSAGE_LOOP_CAP`)
 * apply at read time.
 */
function normalizeMessaging(
  value: unknown,
): GlobalConfig["messaging"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("messaging must be an object");
  const messaging: NonNullable<GlobalConfig["messaging"]> = {};
  if (value.parentReplyTimeoutMinutes !== undefined) {
    if (
      typeof value.parentReplyTimeoutMinutes !== "number" ||
      !Number.isFinite(value.parentReplyTimeoutMinutes) ||
      value.parentReplyTimeoutMinutes <= 0
    ) {
      throw new Error(
        "messaging.parentReplyTimeoutMinutes must be a positive number",
      );
    }
    messaging.parentReplyTimeoutMinutes = value.parentReplyTimeoutMinutes;
  }
  if (value.loopCap !== undefined) {
    if (
      typeof value.loopCap !== "number" ||
      !Number.isInteger(value.loopCap) ||
      value.loopCap <= 0
    ) {
      throw new Error("messaging.loopCap must be a positive integer");
    }
    messaging.loopCap = value.loopCap;
  }
  return messaging;
}

function normalizeAutomation(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new Error("automation must be a boolean");
  return value;
}

/** A retired `movers` list, when it is a list of strings. */
function legacyMovers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((name): name is string => typeof name === "string");
}

/** `sources.<id>`: `{ enabled?: boolean, settings?: object }` (settings checked against the source's schema at use). */
function normalizeSources(
  value: unknown,
): Record<string, SourceConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new Error("sources must be an object keyed by source id");
  const sources: Record<string, SourceConfig> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry)) throw new Error(`sources.${id} must be an object`);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw new Error(`sources.${id}.enabled must be a boolean`);
    }
    if (entry.settings !== undefined && !isRecord(entry.settings)) {
      throw new Error(`sources.${id}.settings must be an object`);
    }
    sources[id] = {
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
      ...(entry.settings !== undefined
        ? { settings: entry.settings as Record<string, unknown> }
        : {}),
    };
  }
  return sources;
}

/** Absolute folder containing every repository checkout (default `~/Code`). */
function normalizeCodeRoot(value: unknown): string {
  if (value === undefined) return join(homedir(), "Code");
  if (typeof value !== "string" || !value.trim())
    throw new Error("codeRoot must be a non-empty path");
  const trimmed = value.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(expanded))
    throw new Error("codeRoot must be absolute or start with ~/");
  return resolve(expanded);
}

/** Optional namespace prefix for branches Harbormaster creates (default none). */
function normalizeBranchPrefix(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string")
    throw new Error("branchPrefix must be a string");
  const prefix = value.trim().replace(/\/+$/, "");
  if (!prefix) return "";
  const components = prefix.split("/");
  const prohibitedChars = /[~^:?*[\]\\]/;
  const hasControlChar = [...prefix].some(
    (char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f,
  );
  if (
    prefix.startsWith("/") ||
    prefix.startsWith("-") ||
    prefix.includes("//") ||
    prefix.includes("..") ||
    prefix.includes("@{") ||
    prohibitedChars.test(prefix) ||
    hasControlChar ||
    components.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        part.endsWith(".") ||
        part.endsWith(".lock"),
    )
  ) {
    throw new Error("branchPrefix is not a valid Git branch namespace");
  }
  return `${prefix}/`;
}
