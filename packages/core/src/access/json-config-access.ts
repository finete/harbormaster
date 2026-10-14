// Resource Access: per-user global config file. Simplified from pi-home's
// src/access/global-config-access.ts — repositories/headless-model fields
// are GitHub/addon concerns that return with those phases; the automation
// kill switch and mover order placeholder survive as a seam, and phase 2b
// adds back codeRoot/branchPrefix (see contracts/workspace.ts) now that git
// repository/worktree access needs them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  DeploymentPipeline,
  DeploymentStageConfig,
  GlobalConfig,
  RepositoryConfig,
} from "../contracts/model.js";
import { defaultGlobalConfig } from "../contracts/model.js";
import type { ConfigAccess } from "../contracts/services.js";
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
      const movers = normalizeMovers("movers", raw.movers);
      return {
        automation: normalizeAutomation(raw.automation),
        ...(movers ? { movers } : {}),
        codeRoot: normalizeCodeRoot(raw.codeRoot),
        branchPrefix: normalizeBranchPrefix(raw.branchPrefix),
        ...(repositories ? { repositories } : {}),
      };
    } catch (error) {
      throw this.invalid(error);
    }
  }

  async save(config: GlobalConfig): Promise<void> {
    await writeJsonAtomic(this.path, config);
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
    const movers = normalizeMovers(
      `repositories.${repositoryId}.movers`,
      entry.movers,
    );
    if (movers) config.movers = movers;
    repositories[repositoryId] = config;
  }
  return repositories;
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

function normalizeAutomation(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new Error("automation must be a boolean");
  return value;
}

/**
 * Absent = `undefined` (built-in default order); an explicit empty list is
 * kept as-is and disables automatic moves. Whether each name is a
 * registered mover is a registry concern checked by the manager (one
 * load-time warning), not here.
 */
function normalizeMovers(at: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error(`${at} must be an array of strings`);
  const seen = new Set<string>();
  return value.map((name) => {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`${at} entries must be non-empty mover names`);
    }
    const trimmed = name.trim();
    if (seen.has(trimmed)) {
      throw new Error(`${at} lists mover "${trimmed}" twice`);
    }
    seen.add(trimmed);
    return trimmed;
  });
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
