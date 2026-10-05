// Resource Access: per-user global config file. Simplified from pi-home's
// src/access/global-config-access.ts — branchPrefix/codeRoot/repositories/
// headless-model fields are git/GitHub/addon concerns that return with
// those phases; only the automation kill switch and mover order placeholder
// survive as a seam.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GlobalConfig } from "../contracts/model.js";
import { defaultGlobalConfig } from "../contracts/model.js";
import type { ConfigAccess } from "../contracts/services.js";
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
      const config = defaultGlobalConfig();
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
