// The Settings page's pure helpers (lib/settings-form.ts, docs/settings.md
// S4/S5/S8/S12/S13): draft parsing for commit-on-Enter/blur fields, the
// config.json problem banner, and the small derived lines.
import { describe, expect, it } from "vitest";
import type {
  HarnessModelCatalog,
  SettingDescription,
  SettingsSource,
} from "../src/preload/api";
import {
  autoFormSources,
  automationLine,
  configErrorText,
  integerHint,
  ipcErrorText,
  isExplicit,
  isSameValue,
  minutesToMs,
  modelChoices,
  msToMinutes,
  overriddenHint,
  parseIntegerDraft,
  parseMinutesDraft,
  parseSourceNumberDraft,
  parseSourceTextDraft,
  parseStringDraft,
  priorityFilterLine,
  SETTINGS_SECTIONS,
  settingsSection,
  sourceFieldValue,
  sourceFormFields,
  sourceSettingKey,
  valueText,
} from "../src/renderer/src/lib/settings-form";

const maxConcurrent: SettingDescription = {
  key: "launch.maxConcurrent",
  type: "integer",
  default: 6,
  min: 1,
  max: 64,
  title: "Max tasks running at once",
  help: "",
  section: "agents",
};

function stringSetting(
  extra: Partial<SettingDescription> = {},
): SettingDescription {
  return {
    key: "codeRoot",
    type: "string",
    default: "~/Code",
    title: "Code folder",
    help: "",
    section: "general",
    ...extra,
  };
}

describe("sections", () => {
  it("lists the sections most used first (S7)", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "general",
      "agents",
      "code-review",
      "github",
      "inbox",
    ]);
  });
  it("falls back to General for an unknown section", () => {
    expect(settingsSection("agents")).toBe("agents");
    expect(settingsSection("github")).toBe("github");
    expect(settingsSection("repositories")).toBe("general");
    expect(settingsSection(undefined)).toBe("general");
  });
});

describe("parseIntegerDraft", () => {
  it("accepts a whole number inside the bounds, blanks ignored", () => {
    expect(parseIntegerDraft(" 12 ", maxConcurrent)).toEqual({
      ok: true,
      value: 12,
    });
    expect(parseIntegerDraft("1", maxConcurrent)).toEqual({
      ok: true,
      value: 1,
    });
    expect(parseIntegerDraft("64", maxConcurrent)).toEqual({
      ok: true,
      value: 64,
    });
  });
  it("hints with the bounds for anything else (nothing is saved)", () => {
    const hint = "Enter a whole number from 1 to 64.";
    for (const text of ["0", "65", "1.5", "abc", "", "1e3", "-"]) {
      expect(parseIntegerDraft(text, maxConcurrent)).toEqual({
        ok: false,
        hint,
      });
    }
  });
  it("words the hint by which bounds exist", () => {
    const { max: _max, ...minOnly } = maxConcurrent;
    const { min: _min, ...maxOnly } = maxConcurrent;
    const { min: _a, max: _b, ...none } = maxConcurrent;
    expect(integerHint(minOnly)).toBe("Enter a whole number of at least 1.");
    expect(integerHint(maxOnly)).toBe("Enter a whole number up to 64.");
    expect(integerHint(none)).toBe("Enter a whole number.");
  });
});

describe("parseStringDraft", () => {
  it("trims a value", () => {
    expect(parseStringDraft("  ~/src ", stringSetting())).toEqual({
      ok: true,
      value: "~/src",
    });
  });
  it("refuses empty unless allowed; a null default means reset", () => {
    expect(parseStringDraft("  ", stringSetting())).toEqual({
      ok: false,
      hint: "Code folder must not be empty.",
    });
    expect(parseStringDraft("", stringSetting({ allowEmpty: true }))).toEqual({
      ok: true,
      value: "",
    });
    expect(parseStringDraft(" ", stringSetting({ default: null }))).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("values", () => {
  it("shows absent values as empty text", () => {
    expect(valueText(null)).toBe("");
    expect(valueText(undefined)).toBe("");
    expect(valueText(13)).toBe("13");
    expect(valueText(false)).toBe("false");
  });
  it("skips writes that change nothing", () => {
    expect(isSameValue(6, 6)).toBe(true);
    expect(isSameValue(undefined, null)).toBe(true);
    expect(isSameValue("a", "b")).toBe(false);
    expect(isSameValue(null, "")).toBe(false);
  });
  it("marks a key changed while config.json sets it", () => {
    const snapshot = { explicit: ["launch.maxConcurrent"] };
    expect(isExplicit(snapshot, "launch.maxConcurrent")).toBe(true);
    expect(isExplicit(snapshot, "branchPrefix")).toBe(false);
  });
});

describe("lines", () => {
  it("words the config.json problem with its position when known", () => {
    expect(
      configErrorText({ message: "Unexpected token", line: 3, column: 7 }),
    ).toBe("config.json has a problem: Unexpected token (line 3, column 7)");
    expect(
      configErrorText({
        message:
          "Expected ',' or '}' after property value in JSON at position 31 (line 3 column 3)",
        line: 3,
        column: 3,
      }),
    ).toBe(
      "config.json has a problem: Expected ',' or '}' after property value in JSON (line 3, column 3)",
    );
    expect(configErrorText({ message: "Bad", line: 2 })).toBe(
      "config.json has a problem: Bad (line 2)",
    );
    expect(configErrorText({ message: "launch.loopCap is bad" })).toBe(
      "config.json has a problem: launch.loopCap is bad",
    );
  });
  it("counts repository overrides, silent at zero", () => {
    expect(overriddenHint(undefined)).toBeUndefined();
    expect(overriddenHint(0)).toBeUndefined();
    expect(overriddenHint(1)).toBe("Overridden in 1 repository");
    expect(overriddenHint(3)).toBe("Overridden in 3 repositories");
  });
  it("states automation", () => {
    expect(automationLine(true)).toBe("Automation is on");
    expect(automationLine(false)).toBe("Automation is off");
  });
  it("strips Electron's invoke prefix from a rejection", () => {
    expect(
      ipcErrorText(
        new Error(
          "Error invoking remote method 'core:updateSettings': Error: launch.maxConcurrent must be at most 64",
        ),
      ),
    ).toBe("launch.maxConcurrent must be at most 64");
    expect(ipcErrorText("plain")).toBe("plain");
  });
});

describe("modelChoices", () => {
  const catalogs = [
    { harness: "pi", models: [{ id: "opus" }, { id: "sonnet" }] },
    { harness: "claude-code", models: [] },
  ] as unknown as HarnessModelCatalog[];
  it("offers the agent default, then the catalog", () => {
    expect(modelChoices(catalogs, "pi", null)).toEqual([
      { value: "", label: "Agent default" },
      { value: "opus", label: "opus" },
      { value: "sonnet", label: "sonnet" },
    ]);
  });
  it("keeps a configured model the catalog does not list", () => {
    expect(modelChoices(catalogs, "pi", "haiku")?.at(-1)).toEqual({
      value: "haiku",
      label: "haiku (not listed)",
    });
  });
  it("is undefined (free text) without models for the agent", () => {
    expect(modelChoices(catalogs, "claude-code", null)).toBeUndefined();
    expect(modelChoices(catalogs, "aider", null)).toBeUndefined();
  });
});

const searchInterval: SettingDescription = {
  key: "sources.github.settings.searchIntervalMs",
  type: "integer",
  default: 300_000,
  min: 60_000,
  max: 24 * 60 * 60_000,
  unit: "ms",
  title: "Check interval",
  help: "",
  section: "github",
};

describe("minutes shown for milliseconds (S10)", () => {
  it("converts both ways", () => {
    expect(msToMinutes(300_000)).toBe(5);
    expect(msToMinutes(90_000)).toBe(2);
    expect(msToMinutes(null)).toBeNull();
    expect(msToMinutes("5")).toBeNull();
    expect(minutesToMs(7)).toBe(420_000);
  });

  it("commits whole minutes inside the bounds as milliseconds", () => {
    expect(parseMinutesDraft(" 10 ", searchInterval)).toEqual({
      ok: true,
      value: 600_000,
    });
    expect(parseMinutesDraft("1", searchInterval)).toEqual({
      ok: true,
      value: 60_000,
    });
    for (const bad of ["0", "1.5", "", "abc", "1441"]) {
      expect(parseMinutesDraft(bad, searchInterval)).toEqual({
        ok: false,
        hint: "Enter a whole number of minutes from 1 to 1440.",
      });
    }
  });
});

describe("add-on source forms from a JSON Schema (S10)", () => {
  const schema = {
    type: "object",
    properties: {
      enabledFeature: { type: "boolean", title: "Watch drafts", default: true },
      threshold: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "How many",
        default: 3,
      },
      ratio: { type: "number" },
      label: { type: "string", default: 5 },
      mode: { type: "string", enum: ["fast", "slow"], default: "slow" },
      tags: { type: "array", items: { type: "string" } },
      either: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
  };

  it("maps each property to a control, using title / description / default", () => {
    expect(sourceFormFields(schema)).toEqual([
      {
        name: "enabledFeature",
        label: "Watch drafts",
        kind: "boolean",
        default: true,
      },
      {
        name: "threshold",
        label: "threshold",
        help: "How many",
        kind: "integer",
        min: 1,
        max: 10,
        default: 3,
      },
      { name: "ratio", label: "ratio", kind: "number" },
      // A default of the wrong kind is ignored.
      { name: "label", label: "label", kind: "string" },
      {
        name: "mode",
        label: "mode",
        kind: "enum",
        values: ["fast", "slow"],
        default: "slow",
      },
      { name: "tags", label: "tags", kind: "file" },
      { name: "either", label: "either", kind: "file" },
    ]);
    expect(sourceFormFields(undefined)).toEqual([]);
    expect(sourceFormFields({ type: "object" })).toEqual([]);
  });

  it("parses number and text drafts (empty resets)", () => {
    const integer = { kind: "integer" as const, min: 1, max: 10 };
    expect(parseSourceNumberDraft("4", integer)).toEqual({
      ok: true,
      value: 4,
    });
    expect(parseSourceNumberDraft("", integer)).toEqual({
      ok: true,
      value: null,
    });
    expect(parseSourceNumberDraft("4.5", integer)).toEqual({
      ok: false,
      hint: "Enter a whole number from 1 to 10.",
    });
    expect(parseSourceNumberDraft("11", integer).ok).toBe(false);
    expect(parseSourceNumberDraft("0.25", { kind: "number" })).toEqual({
      ok: true,
      value: 0.25,
    });
    expect(parseSourceNumberDraft("x", { kind: "number" })).toEqual({
      ok: false,
      hint: "Enter a number.",
    });
    expect(parseSourceTextDraft("  hi ")).toEqual({ ok: true, value: "hi" });
    expect(parseSourceTextDraft("  ")).toEqual({ ok: true, value: null });
  });

  it("shows the configured value, else the schema default", () => {
    const [toggle, threshold] = sourceFormFields(schema);
    if (!toggle || !threshold) throw new Error("fields missing");
    expect(sourceFieldValue({ settings: {} }, toggle)).toBe(true);
    expect(
      sourceFieldValue({ settings: { enabledFeature: false } }, toggle),
    ).toBe(false);
    expect(sourceFieldValue({ settings: { threshold: 7 } }, threshold)).toBe(7);
  });

  it("gives add-ons (and option-carrying built-ins other than github / version-endpoint) a form", () => {
    const source = (
      id: string,
      builtin: boolean,
      settingsSchema?: Record<string, unknown>,
    ): SettingsSource => ({
      id,
      label: id,
      builtin,
      enabled: true,
      enabledExplicit: false,
      ...(settingsSchema ? { settingsSchema } : {}),
      settings: {},
      explicit: [],
      problems: [],
    });
    expect(
      autoFormSources([
        source("harbormaster", true),
        source("github", true, schema),
        source("version-endpoint", true),
        source("pinger", false),
        source("weather", false, schema),
        source("future-builtin", true, schema),
      ]).map((entry) => entry.id),
    ).toEqual(["pinger", "weather", "future-builtin"]);
    expect(sourceSettingKey("pinger")).toBe("sources.pinger.enabled");
    expect(sourceSettingKey("pinger", "threshold")).toBe(
      "sources.pinger.settings.threshold",
    );
  });
});

describe("priorityFilterLine", () => {
  it("says whether a custom filter is set", () => {
    expect(priorityFilterLine(null)).toBe(
      "Not set: each item's own priority applies",
    );
    expect(priorityFilterLine('item.kind == "rule"')).toBe("Custom filter set");
  });
});
