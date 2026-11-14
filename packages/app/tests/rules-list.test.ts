// Component test for the Rules tab body (components/RulesList.tsx): the
// three degenerate states of docs/rules-page.md decision 12, rendered to
// static markup (no DOM needed; the component is purely presentational).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RuleFile, RulesListing } from "../src/preload/api";
import {
  ONLY_BROKEN_HINT,
  RULES_OFF_BANNER,
  RulesList,
  type RulesListProps,
} from "../src/renderer/src/components/RulesList";

const loaded: RuleFile = {
  file: "rules.yaml",
  path: "/state/rules/rules.yaml",
  rules: [
    {
      id: "pr-merged",
      label: "PR merged",
      on: ["github.pr.*", "harbormaster.task.*", "x.y"],
      do: [{ action: "move", with: { to: "await", kind: "deploy" } }],
      file: "rules.yaml",
      line: 3,
      condition: { kind: "always" },
      activity: {
        lastAt: "2026-11-14T10:00:00.000Z",
        lastOutcome: "applied",
        count: 2,
      },
    },
  ],
  problems: [],
};

const broken: RuleFile = {
  file: "rules.yaml",
  path: "/state/rules/rules.yaml",
  rules: [],
  problems: ["rules.yaml:7: rule `x`: `label` is required"],
};

function render(
  listing: Partial<RulesListing>,
  props: Partial<RulesListProps> = {},
): string {
  const noop = (): void => {};
  return renderToStaticMarkup(
    createElement(RulesList, {
      listing: {
        files: [],
        enabled: true,
        activityWindowDays: 30,
        ...listing,
      },
      repoLabel: (id: string) => id,
      selected: null,
      now: Date.parse("2026-11-14T12:00:00.000Z"),
      onSelect: noop,
      onOpenFile: noop,
      onOpenFolder: noop,
      onRestoreDefaults: noop,
      onTurnOn: noop,
      ...props,
    }),
  );
}

/** Decode the few entities renderToStaticMarkup emits in text. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

describe("RulesList", () => {
  it("lists rules: header, two-line row with chips, dot and last fired", () => {
    const html = render({ files: [loaded] });
    const plain = text(html);
    expect(html).toContain('data-state="list"');
    expect(plain).toContain(
      "rules.yaml · 1 rule · applies to every repository without an override",
    );
    expect(plain).toContain("PR merged");
    expect(plain).toContain("2h ago");
    expect(plain).toContain("+1");
    expect(plain).toContain("move → await:deploy");
    expect(html).toContain('data-dot="ok"');
    expect(html).not.toContain("rules-off-banner");
  });

  it("no per-file or per-row actions (the top bar's Edit opens the folder)", () => {
    const html = render({ files: [loaded] });
    expect(html).not.toContain("rules-file-edit");
    expect(html).not.toContain("rule-row-open");
    expect(html).not.toContain("rules-file-open");
    expect(html).not.toContain("group-hover");
    // Neither the file header nor the row hosts a button.
    const section = html.slice(html.indexOf('data-testid="rules-file-'));
    expect(section).not.toContain("<button");
  });

  it("rules off: amber banner with Turn on, list dimmed", () => {
    const html = render({ files: [loaded], enabled: false });
    expect(text(html)).toContain(RULES_OFF_BANNER);
    expect(RULES_OFF_BANNER).toBe(
      "Rules are turned off — they're loaded but never run.",
    );
    expect(html).toContain('data-testid="rules-turn-on"');
    expect(html).toContain("data-dimmed");
    expect(html).toContain("opacity-60");
    expect(text(html).toLowerCase()).not.toContain("automation");
  });

  it("no files: empty state with Restore defaults and Open rules folder", () => {
    const html = render({ files: [] });
    expect(html).toContain('data-state="no-files"');
    expect(text(html)).toContain("No rules files");
    expect(html).toContain('data-testid="rules-restore-defaults"');
    expect(html).toContain('data-testid="rules-empty-open-folder"');
    expect(text(html)).toContain("Restore defaults");
    expect(text(html)).toContain("Open rules folder");
  });

  it("no files and an unknown folder: Open rules folder is disabled", () => {
    const html = render({ files: [] }, { onOpenFolder: undefined });
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*data-testid="rules-empty-open-folder"|<button[^>]*data-testid="rules-empty-open-folder"[^>]*disabled=""/,
    );
  });

  it("only broken files: header, problems, one-line hint, Open in editor", () => {
    const html = render({ files: [broken] });
    const plain = text(html);
    expect(html).toContain('data-state="only-broken"');
    expect(plain).toContain(
      "rules.yaml · not loaded · repositories without an override currently have no rules",
    );
    expect(plain).toContain("line 7 · rule `x`: `label` is required");
    expect(plain).toContain(ONLY_BROKEN_HINT);
    expect(ONLY_BROKEN_HINT).toBe(
      "Nothing is loaded. Fix the problem above and the rules will reload on the next refresh.",
    );
    expect(html).toContain('data-testid="rules-only-broken-open"');
    expect(plain).toContain("Open in editor");
    // No per-file Edit button on the broken file's header either.
    expect(html).not.toContain("rules-file-edit");
  });
});
