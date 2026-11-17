// Engine: the pure rules behind the settings description (docs/settings.md
// S6): validating an `updateSettings` patch against `SETTINGS_DESCRIPTION`,
// reading effective values / explicit keys, and diffing two configs into
// the changed key paths that drive the manager's change reactions.

import {
  SETTINGS_DESCRIPTION,
  type SettingDescription,
  type SettingsPatch,
  type SettingValue,
} from "../contracts/settings.js";

/** The described setting at `key`, if any. */
export function settingDescription(
  key: string,
): SettingDescription | undefined {
  return SETTINGS_DESCRIPTION.find((entry) => entry.key === key);
}

export interface SettingsValidationContext {
  /** Registered agent ids (built-ins and custom), for `harness` settings. */
  harnessIds: readonly string[];
}

export interface SettingsValidation {
  /** Normalized values to write (`null` = remove the key); only when `problems` is empty. */
  values: Record<string, SettingValue | null>;
  problems: string[];
}

/**
 * Check every entry of `patch` against the description: the key must be
 * described, `null` resets it, and a value must have the setting's type and
 * fit its constraints. Strings are trimmed.
 */
export function validateSettingsPatch(
  patch: SettingsPatch,
  context: SettingsValidationContext,
): SettingsValidation {
  const values: Record<string, SettingValue | null> = {};
  const problems: string[] = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { values, problems: ["Settings must be an object of key → value."] };
  }
  for (const [key, value] of Object.entries(patch)) {
    const setting = settingDescription(key);
    if (!setting) {
      problems.push(`Unknown setting "${key}".`);
      continue;
    }
    if (value === null) {
      values[key] = null;
      continue;
    }
    const checked = checkValue(setting, value, context);
    if (typeof checked === "object") problems.push(checked.problem);
    else values[key] = checked;
  }
  return { values, problems };
}

function checkValue(
  setting: SettingDescription,
  value: unknown,
  context: SettingsValidationContext,
): SettingValue | { problem: string } {
  const at = `${setting.title} (${setting.key})`;
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean"
        ? value
        : { problem: `${at} must be on or off.` };
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { problem: `${at} must be a whole number.` };
      }
      if (setting.min !== undefined && value < setting.min) {
        return { problem: `${at} must be at least ${setting.min}.` };
      }
      if (setting.max !== undefined && value > setting.max) {
        return { problem: `${at} must be at most ${setting.max}.` };
      }
      return value;
    }
    case "string": {
      if (typeof value !== "string") {
        return { problem: `${at} must be text.` };
      }
      const trimmed = value.trim();
      if (!trimmed && !setting.allowEmpty) {
        return { problem: `${at} must not be empty.` };
      }
      return trimmed;
    }
    case "enum": {
      if (typeof value !== "string" || !setting.values?.includes(value)) {
        return {
          problem: `${at} must be one of: ${(setting.values ?? []).join(", ")}.`,
        };
      }
      return value;
    }
    case "harness": {
      const id = typeof value === "string" ? value.trim() : "";
      if (!id) return { problem: `${at} must name an agent.` };
      if (!context.harnessIds.includes(id)) {
        return {
          problem: `Unknown agent "${id}". Available: ${context.harnessIds.join(", ")}.`,
        };
      }
      return id;
    }
  }
}

/** Whether `key` (dotted path) is present in `object`, and its value. */
export function readKeyPath(
  object: unknown,
  key: string,
): { found: boolean; value?: unknown } {
  let current: unknown = object;
  for (const part of key.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) {
      return { found: false };
    }
    current = current[part];
  }
  return { found: current !== undefined, value: current };
}

/** Effective value per described key: the config's when set, else the default. */
export function settingsValues(
  config: unknown,
): Record<string, SettingValue | null> {
  const values: Record<string, SettingValue | null> = {};
  for (const setting of SETTINGS_DESCRIPTION) {
    const read = readKeyPath(config, setting.key);
    values[setting.key] =
      read.found && isSettingValue(read.value) ? read.value : setting.default;
  }
  return values;
}

/** Described keys present in a raw config object. */
export function explicitSettingKeys(raw: unknown): string[] {
  return SETTINGS_DESCRIPTION.filter(
    (setting) => readKeyPath(raw, setting.key).found,
  ).map((setting) => setting.key);
}

/**
 * Every leaf key path whose value differs between two configs (objects
 * recurse; arrays and scalars are leaves compared by JSON). Sorted.
 */
export function changedConfigKeys(previous: unknown, next: unknown): string[] {
  const changed = new Set<string>();
  const walk = (a: unknown, b: unknown, prefix: string): void => {
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key], b[key], prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.add(prefix);
  };
  walk(previous, next, "");
  return [...changed].sort();
}

/** Whether any changed key is `key` itself or lies under it (`sources` matches `sources.github.enabled`). */
export function affectsConfiguration(
  changedKeys: readonly string[],
  key: string,
): boolean {
  return changedKeys.some(
    (changed) =>
      changed === key ||
      changed.startsWith(`${key}.`) ||
      key.startsWith(`${changed}.`),
  );
}

function isSettingValue(value: unknown): value is SettingValue {
  return (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
