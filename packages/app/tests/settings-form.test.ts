// The Settings page's pure helpers (lib/settings-form.ts, docs/settings.md
// S4/S5/S8/S12/S13): draft parsing for commit-on-Enter/blur fields, the
// config.json problem banner, and the small derived lines.
import { describe, expect, it } from "vitest";
import type {
  HarnessModelCatalog,
  SettingDescription,
} from "../src/preload/api";
import {
  automationLine,
  configErrorText,
  integerHint,
  ipcErrorText,
  isExplicit,
  isSameValue,
  modelChoices,
  overriddenHint,
  parseIntegerDraft,
  parseStringDraft,
  SETTINGS_SECTIONS,
  settingsSection,
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
  it("lists only the built sections, General first", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "general",
      "agents",
      "code-review",
    ]);
  });
  it("falls back to General for an unknown or unbuilt section", () => {
    expect(settingsSection("agents")).toBe("agents");
    expect(settingsSection("github")).toBe("general");
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
