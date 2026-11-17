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
  SettingsSource,
  SettingValue,
} from "../../../preload/api";

/** A Settings page section (S7): id from the description, plus its label. */
export interface SettingsSectionInfo {
  id: SettingSectionId;
  label: string;
}

/** The sections, most used first (S7). */
export const SETTINGS_SECTIONS: readonly SettingsSectionInfo[] = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "code-review", label: "Code review" },
  { id: "github", label: "GitHub & sources" },
  { id: "inbox", label: "Inbox & messaging" },
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

// --- Minutes shown for a stored millisecond value (S10) -------------------

const MINUTE_MS = 60_000;

/** A millisecond setting value as whole minutes (rounded) for its field. */
export function msToMinutes(
  value: SettingValue | null | undefined,
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value / MINUTE_MS)
    : null;
}

/** Minutes → the stored milliseconds. */
export function minutesToMs(minutes: number): number {
  return minutes * MINUTE_MS;
}

/**
 * A minutes field's draft for a setting stored in ms (`unit: "ms"`): a
 * whole number of minutes inside the setting's bounds (converted), at
 * least 1; the committed value is milliseconds.
 */
export function parseMinutesDraft(
  text: string,
  setting: SettingDescription,
): DraftResult {
  const min = Math.max(1, Math.ceil((setting.min ?? MINUTE_MS) / MINUTE_MS));
  const max =
    setting.max !== undefined ? Math.floor(setting.max / MINUTE_MS) : undefined;
  const hint =
    max !== undefined
      ? `Enter a whole number of minutes from ${min} to ${max}.`
      : `Enter a whole number of minutes, at least ${min}.`;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, hint };
  const minutes = Number(trimmed);
  if (minutes < min || (max !== undefined && minutes > max)) {
    return { ok: false, hint };
  }
  return { ok: true, value: minutesToMs(minutes) };
}

// --- Add-on sources: forms drawn from a JSON Schema (S10) -----------------

/** One property of a source's `settingsSchema`, as a form row. */
export type SourceField =
  | {
      kind: "boolean" | "string";
      name: string;
      label: string;
      help?: string;
      default?: SettingValue;
    }
  | {
      kind: "integer" | "number";
      name: string;
      label: string;
      help?: string;
      default?: SettingValue;
      min?: number;
      max?: number;
    }
  | {
      kind: "enum";
      name: string;
      label: string;
      help?: string;
      default?: SettingValue;
      values: string[];
    }
  /** Anything else (arrays, objects, unions): "Edit in config.json". */
  | { kind: "file"; name: string; label: string; help?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The form rows for a source's settings schema, in declaration order:
 * boolean → switch, integer / number → number field (`minimum` /
 * `maximum`), string → text field, a string `enum` → select, anything else
 * → "Edit in config.json". The label is the property's `title`, else its
 * name; `description` is the help text; a `default` of the right kind is
 * kept (the value shown while unset).
 */
export function sourceFormFields(schema: unknown): SourceField[] {
  const properties =
    isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(properties).map(([name, raw]) => {
    const property = isRecord(raw) ? raw : {};
    const label =
      typeof property.title === "string" && property.title.trim()
        ? property.title.trim()
        : name;
    const base = {
      name,
      label,
      ...(typeof property.description === "string" && property.description
        ? { help: property.description }
        : {}),
    };
    const fallback = property.default;
    const withDefault = (ok: boolean) =>
      ok ? { default: fallback as SettingValue } : {};
    if (
      Array.isArray(property.enum) &&
      property.enum.length > 0 &&
      property.enum.every((value) => typeof value === "string")
    ) {
      const values = property.enum as string[];
      return {
        ...base,
        kind: "enum",
        values,
        ...withDefault(
          typeof fallback === "string" && values.includes(fallback),
        ),
      };
    }
    switch (property.type) {
      case "boolean":
        return {
          ...base,
          kind: "boolean",
          ...withDefault(typeof fallback === "boolean"),
        };
      case "string":
        return {
          ...base,
          kind: "string",
          ...withDefault(typeof fallback === "string"),
        };
      case "integer":
      case "number": {
        const kind: "integer" | "number" = property.type;
        return {
          ...base,
          kind,
          ...(typeof property.minimum === "number"
            ? { min: property.minimum }
            : {}),
          ...(typeof property.maximum === "number"
            ? { max: property.maximum }
            : {}),
          ...withDefault(
            typeof fallback === "number" &&
              (kind === "number" || Number.isInteger(fallback)),
          ),
        };
      }
      default:
        return { ...base, kind: "file" };
    }
  });
}

/** A number field's draft for a schema property (`integer` → whole numbers). */
export function parseSourceNumberDraft(
  text: string,
  field: { kind: "integer" | "number"; min?: number; max?: number },
): DraftResult {
  const { min, max } = field;
  const what = field.kind === "integer" ? "a whole number" : "a number";
  const hint =
    min !== undefined && max !== undefined
      ? `Enter ${what} from ${min} to ${max}.`
      : min !== undefined
        ? `Enter ${what} of at least ${min}.`
        : max !== undefined
          ? `Enter ${what} up to ${max}.`
          : `Enter ${what}.`;
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  const pattern =
    field.kind === "integer" ? /^-?\d+$/ : /^-?(\d+\.?\d*|\.\d+)$/;
  if (!pattern.test(trimmed)) return { ok: false, hint };
  const value = Number(trimmed);
  if (
    !Number.isFinite(value) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  ) {
    return { ok: false, hint };
  }
  return { ok: true, value };
}

/** A text field's draft for a schema property: trimmed; empty resets. */
export function parseSourceTextDraft(text: string): DraftResult {
  const trimmed = text.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

/** A configured settings value usable by a form control, else `undefined`. */
export function sourceFieldValue(
  source: Pick<SettingsSource, "settings">,
  field: SourceField,
): SettingValue | undefined {
  const value = source.settings[field.name];
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return field.kind === "file" ? undefined : field.default;
}

/** Sources with their own hand-made panel or per-repository settings (S10). */
const NOT_AUTO_FORM = new Set(["github", "version-endpoint"]);

/**
 * The sources that get an automatic form in GitHub & sources: every add-on
 * source, and built-ins that have options (none today besides github,
 * which has its own panel; version-endpoint is per-repository, file only).
 */
export function autoFormSources(
  sources: readonly SettingsSource[] | undefined,
): SettingsSource[] {
  return (sources ?? []).filter(
    (source) =>
      !NOT_AUTO_FORM.has(source.id) &&
      (!source.builtin || sourceFormFields(source.settingsSchema).length > 0),
  );
}

/** `updateSettings` key for a source's on/off switch / one settings property. */
export function sourceSettingKey(sourceId: string, property?: string): string {
  return property === undefined
    ? `sources.${sourceId}.enabled`
    : `sources.${sourceId}.settings.${property}`;
}

/** The "Inbox priority filter" row's line (S1: edited in config.json only). */
export function priorityFilterLine(
  value: SettingValue | null | undefined,
): string {
  return typeof value === "string" && value.trim()
    ? "Custom filter set"
    : "Not set: each item's own priority applies";
}
