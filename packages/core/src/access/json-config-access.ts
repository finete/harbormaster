// Resource Access: per-user global config file. Simplified from pi-home's
// src/access/global-config-access.ts — repositories/headless-model fields
// are GitHub/addon concerns that return with those phases; the automation
// kill switch survives (board automation itself is the rules engine), and phase 2b
// adds back codeRoot/branchPrefix (see contracts/workspace.ts) now that git
// repository/worktree access needs them.

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CustomAgentConfig,
  DeploymentPipeline,
  DeploymentStageConfig,
  GlobalConfig,
  MessageDirectRoutes,
  RepositoryConfig,
  SourceConfig,
} from "../contracts/model.js";
import {
  defaultGlobalConfig,
  MESSAGE_DIRECT_ROUTES,
} from "../contracts/model.js";
import type {
  ConfigAccess,
  ConfigAccessSnapshot,
  ConfigChange,
  ConfigSettingsPatch,
  LegacyMoverOrders,
} from "../contracts/services.js";
import {
  type ConfigFileError,
  SETTINGS_DESCRIPTION,
} from "../contracts/settings.js";
// Imported for its side-effecting declare-module augmentation of
// GlobalConfig (codeRoot/branchPrefix) — contracts/workspace.ts owns those
// fields' types.
import "../contracts/workspace.js";
import { writeJsonAtomic } from "../utilities/atomic-json.js";
import { withFileLock } from "../utilities/file-lock.js";

/** How long the watcher waits for a burst of file events to settle. */
const DEFAULT_WATCH_DEBOUNCE_MS = 150;

/** The last config that loaded, with the file text and raw object behind it. */
interface GoodConfig {
  raw: Record<string, unknown>;
  config: GlobalConfig;
}

/**
 * config.json (docs/settings.md S4): loaded on every `load()` but parsed
 * only when its text changed; an invalid file keeps the last good config
 * in effect (once one loaded) and exposes the problem through `snapshot()`
 * and an `onChange` notification. `startWatching()` adds an fs watcher on
 * the file's directory (robust to atomic renames, debounced), so hand edits
 * are noticed without a load. Core's own writes update the cached text
 * first, so the watcher never reports them again (dedupe by content).
 */
export class JsonConfigAccess implements ConfigAccess {
  private good: GoodConfig | undefined;
  private error: ConfigFileError | undefined;
  /** The file text last read or written (valid or not): unchanged text is never re-parsed or re-reported. */
  private seenText: string | undefined;
  /** Read ordering: a read that started before the last applied one is discarded. */
  private readSeq = 0;
  private appliedSeq = 0;
  private readonly listeners = new Set<(change: ConfigChange) => void>();
  private watcher: FSWatcher | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;

  constructor(
    private readonly path: string,
    options: { watchDebounceMs?: number } = {},
  ) {
    this.debounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  }

  async load(): Promise<GlobalConfig> {
    const loaded = await this.readFile();
    if (loaded !== undefined) return structuredClone(loaded);
    const config: GlobalConfig = {
      ...defaultGlobalConfig(),
      codeRoot: normalizeCodeRoot(undefined),
      branchPrefix: normalizeBranchPrefix(undefined),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const text = `${JSON.stringify(config, null, 2)}\n`;
    try {
      await writeFile(this.path, text, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (writeError) {
      // Another process may have created the config concurrently.
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
        throw writeError;
      const raced = await this.readFile();
      if (raced !== undefined) return structuredClone(raced);
    }
    this.wrote(text, { ...config } as Record<string, unknown>, config);
    return structuredClone(config);
  }

  async snapshot(): Promise<ConfigAccessSnapshot> {
    const config = await this.load();
    const good = this.good;
    return {
      config,
      raw: good ? structuredClone(good.raw) : {},
      ...(this.error ? { error: { ...this.error } } : {}),
    };
  }

  onChange(listener: (change: ConfigChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startWatching(): void {
    if (this.watcher) return;
    const file = basename(this.path);
    try {
      // watch() throws ENOENT on a missing directory (fresh install).
      mkdirSync(dirname(this.path), { recursive: true });
      // The directory, not the file: an atomic rename replaces the file's
      // inode, which a file watcher would stop following.
      this.watcher = watch(dirname(this.path), (_event, filename) => {
        if (filename && filename.toString() !== file) return;
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined;
          this.readFile().catch(() => {
            // First load never succeeded and the file is still invalid:
            // nothing to keep; the next load() reports it.
          });
        }, this.debounceMs);
      });
      this.watcher.on("error", () => this.stopWatching());
    } catch {
      this.watcher = undefined;
    }
  }

  stopWatching(): void {
    clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Read the file and, when its text changed, parse it: a valid config
   * becomes the good one (reported as a `file` change when it differs or
   * clears an error), an invalid one is recorded as the error and the good
   * one kept. Resolves `undefined` when there is no file; throws when the
   * file is invalid and nothing good ever loaded.
   */
  private async readFile(): Promise<GlobalConfig | undefined> {
    const seq = ++this.readSeq;
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      // Missing: load() writes a fresh default (and the watcher ignores it).
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw this.invalid(error);
    }
    if (seq < this.appliedSeq || text === this.seenText) return this.current();
    this.appliedSeq = seq;
    this.seenText = text;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return this.failed(jsonSyntaxError(error, text));
    }
    let config: GlobalConfig;
    try {
      config = this.parse(raw);
    } catch (error) {
      return this.failed({ message: problemOf(error) });
    }
    const previous = this.good?.config;
    const hadError = this.error !== undefined;
    this.good = { raw: raw as Record<string, unknown>, config };
    this.error = undefined;
    if (hadError || (previous && !sameConfig(previous, config))) {
      this.notify({ origin: "file", previous: previous ?? config, config });
    }
    return config;
  }

  /** The good config, or the recorded error thrown when there is none. */
  private current(): GlobalConfig {
    if (this.good) return this.good.config;
    throw this.invalid(new Error(this.error?.message ?? "unreadable"));
  }

  private failed(error: ConfigFileError): GlobalConfig {
    const changed = this.error?.message !== error.message;
    this.error = error;
    if (!this.good) throw this.invalid(new Error(error.message));
    if (changed) {
      const kept = this.good.config;
      this.notify({ origin: "file", previous: kept, config: kept, error });
    }
    return this.good.config;
  }

  /** Core wrote `text` (= `raw` serialized): adopt it so the watcher sees no news, and report the change. */
  private wrote(
    text: string,
    raw: Record<string, unknown>,
    config: GlobalConfig,
    before?: GlobalConfig,
  ): void {
    this.appliedSeq = ++this.readSeq;
    this.seenText = text;
    const previous = this.good?.config ?? before;
    const hadError = this.error !== undefined;
    this.good = { raw, config };
    this.error = undefined;
    if (previous && (hadError || !sameConfig(previous, config))) {
      this.notify({ origin: "core", previous, config });
    }
  }

  private notify(change: ConfigChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(change));
      } catch {
        // A listener's failure is its own; the rest still hear about it.
      }
    }
  }

  /** Validate and normalize a raw config object (throws "Invalid Harbormaster config"). */
  private parse(raw: unknown): GlobalConfig {
    if (!isRecord(raw)) throw this.invalid(new Error("must be a JSON object"));
    try {
      const repositories = normalizeRepositories(raw.repositories);
      const launch = normalizeLaunch(raw.launch);
      const messaging = normalizeMessaging(raw.messaging);
      const sources = normalizeSources(raw.sources);
      const agents = normalizeAgents(raw.agents);
      const inbox = normalizeInbox(raw.inbox);
      const terminal = normalizeTerminal(raw.terminal);
      const notifications = normalizeNotifications(raw.notifications);
      const onboardingCompletedAt = normalizeOptionalText(
        "onboardingCompletedAt",
        raw.onboardingCompletedAt,
      );
      return {
        automation: normalizeAutomation(raw.automation),
        captureAgentBrowser: normalizeCaptureAgentBrowser(
          raw.captureAgentBrowser,
        ),
        ...(sources ? { sources } : {}),
        codeRoot: normalizeCodeRoot(raw.codeRoot),
        branchPrefix: normalizeBranchPrefix(raw.branchPrefix),
        ...(repositories ? { repositories } : {}),
        ...(launch ? { launch } : {}),
        ...(messaging ? { messaging } : {}),
        ...(agents ? { agents } : {}),
        ...(inbox ? { inbox } : {}),
        ...(terminal ? { terminal } : {}),
        ...(notifications ? { notifications } : {}),
        ...(onboardingCompletedAt ? { onboardingCompletedAt } : {}),
      };
    } catch (error) {
      throw this.invalid(error);
    }
  }

  async applySettings(patch: ConfigSettingsPatch): Promise<GlobalConfig> {
    return withFileLock(`${this.path}.lock`, async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw this.invalid(error);
        raw = { ...defaultGlobalConfig() };
      }
      if (!isRecord(raw)) throw this.invalid();
      let before: GlobalConfig | undefined;
      try {
        before = this.parse(raw);
      } catch {
        before = undefined;
      }
      const next = applyPatch(structuredClone(raw), patch);
      const config = this.parse(next);
      const text = await writeJsonAtomic(this.path, next);
      this.wrote(text, next, config, before);
      return structuredClone(config);
    });
  }

  async save(config: GlobalConfig): Promise<void> {
    const text = await writeJsonAtomic(this.path, config);
    try {
      this.wrote(
        text,
        JSON.parse(text) as Record<string, unknown>,
        this.parse(JSON.parse(text)),
      );
    } catch {
      // An unloadable config was saved: the next read reports it.
      this.seenText = undefined;
    }
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
    const detail = cause instanceof Error ? `: ${problemOf(cause)}` : "";
    return new Error(`Invalid Harbormaster config at ${this.path}${detail}`);
  }
}

/** An error's message without the "Invalid Harbormaster config at <path>: " wrapper. */
function problemOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Invalid Harbormaster config at .*?: /, "");
}

/** A JSON.parse failure, located by line/column when V8 says where. */
function jsonSyntaxError(error: unknown, text: string): ConfigFileError {
  const message = error instanceof Error ? error.message : String(error);
  const located = /\(line (\d+) column (\d+)\)/.exec(message);
  if (located) {
    return {
      message,
      line: Number(located[1]),
      column: Number(located[2]),
    };
  }
  const position = /at position (\d+)/.exec(message);
  if (position) {
    const before = text.slice(0, Number(position[1])).split("\n");
    return {
      message,
      line: before.length,
      column: (before.at(-1)?.length ?? 0) + 1,
    };
  }
  return { message };
}

function sameConfig(a: GlobalConfig, b: GlobalConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `patch` applied to a raw config object; every other key is kept verbatim. */
function applyPatch(
  raw: Record<string, unknown>,
  patch: ConfigSettingsPatch,
): Record<string, unknown> {
  const child = (key: string): Record<string, unknown> => {
    const value = raw[key];
    if (isRecord(value)) return value;
    const fresh: Record<string, unknown> = {};
    raw[key] = fresh;
    return fresh;
  };
  if (patch.codeRoot !== undefined) raw.codeRoot = patch.codeRoot;
  if (patch.defaultHarness !== undefined) {
    child("launch").defaultHarness = patch.defaultHarness;
  }
  if (patch.bypassPermissions !== undefined) {
    child("launch").bypassPermissions = patch.bypassPermissions;
  }
  if (patch.customAgent) {
    const agents = child("agents");
    const id = patch.customAgent.id;
    const custom = Array.isArray(agents.custom)
      ? agents.custom.filter((entry) => !(isRecord(entry) && entry.id === id))
      : [];
    custom.push({ ...patch.customAgent });
    agents.custom = custom;
  }
  if (patch.sourceEnabled) {
    const sources = child("sources");
    const { id, enabled } = patch.sourceEnabled;
    const entry = isRecord(sources[id]) ? sources[id] : {};
    sources[id] = { ...entry, enabled };
  }
  if (patch.onboardingCompletedAt !== undefined) {
    raw.onboardingCompletedAt = patch.onboardingCompletedAt;
  }
  if (patch.automation !== undefined) raw.automation = patch.automation;
  if (patch.captureAgentBrowser !== undefined) {
    raw.captureAgentBrowser = patch.captureAgentBrowser;
  }
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (value === null || value === undefined) removeKeyPath(raw, key);
    else setKeyPath(raw, key, value);
  }
  return raw;
}

/** Set dotted `key` in `raw`, creating (or replacing non-object) parents. */
function setKeyPath(
  raw: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const parts = key.split(".");
  const last = parts.pop();
  if (!last || parts.some((part) => !part)) {
    throw new Error(`Invalid setting key "${key}"`);
  }
  let parent = raw;
  for (const part of parts) {
    const child = parent[part];
    if (isRecord(child)) parent = child;
    else {
      const fresh: Record<string, unknown> = {};
      parent[part] = fresh;
      parent = fresh;
    }
  }
  parent[last] = value;
}

/** Remove dotted `key` from `raw`, then any parent object it left empty. */
function removeKeyPath(raw: Record<string, unknown>, key: string): void {
  const parts = key.split(".");
  const chain: Array<Record<string, unknown>> = [raw];
  for (const part of parts.slice(0, -1)) {
    const child = chain.at(-1)?.[part];
    if (!isRecord(child)) return;
    chain.push(child);
  }
  delete chain.at(-1)?.[parts.at(-1) ?? ""];
  for (let index = chain.length - 1; index > 0; index -= 1) {
    if (Object.keys(chain[index] ?? {}).length > 0) break;
    delete chain[index - 1]?.[parts[index - 1] ?? ""];
  }
}

/** The integer bounds the settings description gives `key`. */
function describedBounds(key: string): { min: number; max: number } {
  const setting = SETTINGS_DESCRIPTION.find((entry) => entry.key === key);
  return {
    min: setting?.min ?? 1,
    max: setting?.max ?? Number.MAX_SAFE_INTEGER,
  };
}

/** `terminal.fontSize`: an integer within the described bounds; `terminal.screenReader`: a boolean; absent = the defaults at read time. */
function normalizeTerminal(
  value: unknown,
): GlobalConfig["terminal"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("terminal must be an object");
  const terminal: NonNullable<GlobalConfig["terminal"]> = {};
  if (value.fontSize !== undefined) {
    const { min, max } = describedBounds("terminal.fontSize");
    if (
      typeof value.fontSize !== "number" ||
      !Number.isInteger(value.fontSize) ||
      value.fontSize < min ||
      value.fontSize > max
    ) {
      throw new Error(
        `terminal.fontSize must be a whole number from ${min} to ${max}`,
      );
    }
    terminal.fontSize = value.fontSize;
  }
  if (value.screenReader !== undefined) {
    terminal.screenReader = normalizeBoolean(
      "terminal.screenReader",
      value.screenReader,
    );
  }
  return terminal;
}

/** `notifications.enabled`: a boolean; absent = on. */
function normalizeNotifications(
  value: unknown,
): GlobalConfig["notifications"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("notifications must be an object");
  const notifications: NonNullable<GlobalConfig["notifications"]> = {};
  if (value.enabled !== undefined) {
    notifications.enabled = normalizeBoolean(
      "notifications.enabled",
      value.enabled,
    );
  }
  return notifications;
}

function normalizeOptionalText(at: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${at} must be a string`);
  return value.trim() || undefined;
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
    if (entry.reviewCommand !== undefined)
      agent.reviewCommand = text("reviewCommand");
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
  if (value.directRoutes !== undefined) {
    if (
      typeof value.directRoutes !== "string" ||
      !MESSAGE_DIRECT_ROUTES.includes(value.directRoutes as MessageDirectRoutes)
    ) {
      throw new Error(
        `messaging.directRoutes must be one of: ${MESSAGE_DIRECT_ROUTES.join(", ")}`,
      );
    }
    messaging.directRoutes = value.directRoutes as MessageDirectRoutes;
  }
  return messaging;
}

/** `inbox.priorityFilter`: an optional non-empty CEL string (compiled at use; a bad one is a no-op there). */
function normalizeInbox(value: unknown): GlobalConfig["inbox"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("inbox must be an object");
  const inbox: NonNullable<GlobalConfig["inbox"]> = {};
  if (value.priorityFilter !== undefined) {
    if (
      typeof value.priorityFilter !== "string" ||
      !value.priorityFilter.trim()
    ) {
      throw new Error("inbox.priorityFilter must be a non-empty string");
    }
    inbox.priorityFilter = value.priorityFilter.trim();
  }
  return inbox;
}

function normalizeAutomation(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new Error("automation must be a boolean");
  return value;
}

function normalizeCaptureAgentBrowser(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw new Error("captureAgentBrowser must be a boolean");
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
