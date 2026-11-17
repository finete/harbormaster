// Pure helpers behind the Settings page (docs/settings.md): the section
// list, draft parsing / validation for text and number fields (commit on
// Enter / blur, S5), and the small lines the page shows (config.json
// problem banner, "Overridden in N repositories", automation state).
// Window-free so they are unit-tested (tests/settings-form.test.ts).

import type {
  ConfigFileError,
  HarnessModelCatalog,
  SettingDescription,
  SettingSectionId,
  SettingsSnapshot,
  SettingValue,
} from "../../../preload/api";

/** A Settings page section (S7): id from the description, plus its label. */
export interface SettingsSectionInfo {
  id: SettingSectionId;
  label: string;
}

/**
 * The sections built so far, most used first (S7). GitHub & sources and
 * Inbox & messaging arrive in step 3 (S14); no empty placeholders.
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionInfo[] = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "code-review", label: "Code review" },
];

/** `id` when it names a built section, else the first one. */
export function settingsSection(id: string | undefined): SettingSectionId {
  return (
    SETTINGS_SECTIONS.find((section) => section.id === id)?.id ??
    SETTINGS_SECTIONS[0]?.id ??
    "general"
  );
}

/** The described setting at `key` in a snapshot. */
export function findSetting(
  snapshot: Pick<SettingsSnapshot, "description">,
  key: string,
): SettingDescription | undefined {
  return snapshot.description.find((entry) => entry.key === key);
}

/** Whether `key` is set in config.json (the "changed" dot + reset, S12). */
export function isExplicit(
  snapshot: Pick<SettingsSnapshot, "explicit">,
  key: string,
): boolean {
  return snapshot.explicit.includes(key);
}

/** What a field's draft text means once committed. */
export type DraftResult =
  | { ok: true; value: SettingValue | null }
  | { ok: false; hint: string };

/** "Enter a whole number from 1 to 64." (bounds from the description). */
export function integerHint(setting: SettingDescription): string {
  const { min, max } = setting;
  if (min !== undefined && max !== undefined) {
    return `Enter a whole number from ${min} to ${max}.`;
  }
  if (min !== undefined) return `Enter a whole number of at least ${min}.`;
  if (max !== undefined) return `Enter a whole number up to ${max}.`;
  return "Enter a whole number.";
}

/**
 * An integer field's draft: digits only (surrounding blanks ignored),
 * inside the description's bounds; anything else is an inline hint and
 * nothing is saved (S5).
 */
export function parseIntegerDraft(
  text: string,
  setting: SettingDescription,
): DraftResult {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed))
    return { ok: false, hint: integerHint(setting) };
  const value = Number(trimmed);
  if (
    !Number.isSafeInteger(value) ||
    (setting.min !== undefined && value < setting.min) ||
    (setting.max !== undefined && value > setting.max)
  ) {
    return { ok: false, hint: integerHint(setting) };
  }
  return { ok: true, value };
}

/**
 * A text field's draft, trimmed. Empty is allowed when the setting allows
 * it (`allowEmpty`), and for a setting whose default is "no value" (e.g.
 * `launch.defaultModel`) it means reset (`null`).
 */
export function parseStringDraft(
  text: string,
  setting: SettingDescription,
): DraftResult {
  const trimmed = text.trim();
  if (trimmed) return { ok: true, value: trimmed };
  if (setting.allowEmpty) return { ok: true, value: "" };
  if (setting.default === null) return { ok: true, value: null };
  return { ok: false, hint: `${setting.title} must not be empty.` };
}

/** A setting value as a field's text. */
export function valueText(value: SettingValue | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Whether committing `next` would change anything (no write for a no-op). */
export function isSameValue(
  current: SettingValue | null | undefined,
  next: SettingValue | null,
): boolean {
  return (current ?? null) === next;
}

/** The top-of-page banner for a config.json that fails to load (S4). */
export function configErrorText(error: ConfigFileError): string {
  // V8's JSON.parse messages carry their own position ("… at position 31
  // (line 3 column 3)"); drop it so the line is said once.
  const message =
    error.line !== undefined
      ? error.message
          .replace(/\s*\(line \d+ column \d+\)\s*$/, "")
          .replace(/\s+at position \d+\s*$/, "")
      : error.message;
  const where =
    error.line !== undefined
      ? ` (line ${error.line}${error.column !== undefined ? `, column ${error.column}` : ""})`
      : "";
  return `config.json has a problem: ${message}${where}`;
}

/** S8: shown under a global setting that repositories override. */
export function overriddenHint(count: number | undefined): string | undefined {
  if (!count || count <= 0) return undefined;
  return `Overridden in ${count} ${count === 1 ? "repository" : "repositories"}`;
}

/** S13: the read-only automation line in General. */
export function automationLine(enabled: boolean): string {
  return enabled ? "Automation is on" : "Automation is off";
}

/** Electron prefixes a rejected `invoke` with "Error invoking remote method '…': Error: ". */
export function ipcErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export interface ModelChoice {
  /** The stored model id; `""` is "the agent's own default" (reset). */
  value: string;
  label: string;
}

/**
 * The Default model choices for `harness` from the `listModels` catalog:
 * "Agent default" first, then the catalog's models, and the configured
 * model when the catalog does not list it (never silently dropped).
 * `undefined` when the catalog has no models for it (free text instead).
 */
export function modelChoices(
  catalogs: readonly HarnessModelCatalog[],
  harness: string,
  current: string | null,
): ModelChoice[] | undefined {
  const catalog = catalogs.find((entry) => entry.harness === harness);
  if (!catalog || catalog.models.length === 0) return undefined;
  const choices: ModelChoice[] = [{ value: "", label: "Agent default" }];
  for (const model of catalog.models) {
    choices.push({ value: model.id, label: model.id });
  }
  if (current && !catalog.models.some((model) => model.id === current)) {
    choices.push({ value: current, label: `${current} (not listed)` });
  }
  return choices;
}
