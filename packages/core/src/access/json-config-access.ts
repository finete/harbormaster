// Resource Access: per-user global config file. Simplified from pi-home's
// src/access/global-config-access.ts — repositories/headless-model fields
// are GitHub/addon concerns that return with those phases; the automation
// kill switch and mover order placeholder survive as a seam, and phase 2b
// adds back codeRoot/branchPrefix (see contracts/workspace.ts) now that git
// repository/worktree access needs them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GlobalConfig } from "../contracts/model.js";
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
      return {
        automation: normalizeAutomation(raw.automation),
        movers: normalizeMovers(raw.movers),
        codeRoot: normalizeCodeRoot(raw.codeRoot),
        branchPrefix: normalizeBranchPrefix(raw.branchPrefix),
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

function normalizeAutomation(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new Error("automation must be a boolean");
  return value;
}

function normalizeMovers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("movers must be an array of strings");
  return [...value] as string[];
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
