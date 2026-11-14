# Rules page (design record, 2026-11-14)

A read-only view of the rules engine (`docs/release-plan.md` "Rules
engine") in the app: every loaded rule in one place, what it says, what it
did. Settled by grilling, one decision at a time, with rendered mockups.
This file is the contract for implementation; `docs/release-plan.md`
points here.

## Decisions

| # | Decision |
|---|---|
| 1 | **Read-only viewer.** Editing stays in YAML; the page offers "Open in editor". No toggles per rule, no authoring. |
| 2 | **Rules as rows, grouped by file** (global `rules.yaml`, then each `repos/<repo>.yaml` override). |
| 3 | **Full-width list + slide-over sheet** for the selected rule (not a table, not inline-expanding cards). |
| 4 | Row name = the rule's `label` (**now mandatory**, see "Schema change"). Row dot = **last outcome**: mint `applied`, amber `stayed`/`superseded`, red `failed`, grey never fired (in the activity window). |
| 5 | Sheet shows **On · If · Do** plus recent activity. `If` is the user's own CEL, **split by the parser at top-level `&&` / `||` into an ALL / ANY-OF outline**; leaves are verbatim source slices. No English paraphrase of conditions, ever: the outline is structure only, so it cannot misstate the rule. `js:` conditions and unparsable CEL show the raw text with a hint. |
| 6 | Page scope: **Rules** and **Activity** tabs in the page top bar, plus a **Rules on/off switch** (`config.automation`). Sources and dry-run stay CLI-only. |
| 7 | **Activity tab**: actions + warnings by default, "show events" toggle, day group headers, newest first; an action row expands to its triggering event's `data`. Filters: rule, task, outcome. |
| 8 | Sidebar entry **Rules**, between Board and Inbox, lucide `ListChecks`, shortcut **⌘⇧R** (Ctrl+Shift+R elsewhere). |
| 9 | **Two-line rows**: `dot · label · last fired` / `on chips → do chip`. `on` collapses to `+N` beyond two globs. Hover reveals an "Open in editor" icon button. |
| 10 | Sheet is **non-modal, 560px**: no scrim; clicking another row or ↑/↓ swaps it in place; Esc / ✕ closes; the last selection is restored when the page is reopened. |
| 11 | File group headers use **four fixed strings** (below). Load problems are listed under the header as `line N · message` (validator output verbatim). |
| 12 | Degenerate states: rules off → amber banner + **Turn on**, list dimmed; no files → empty state with **Restore defaults** + Open rules folder; only broken files → header + one-line hint + Open in editor. |
| 13 | **Core owns the data**: per-rule activity summary (fold over the audit log, 30-day window), absolute file `path`, `ruleId` filter on `listEvents`, `setRulesEnabled`. The renderer only displays. |
| 14 | Re-fetch on page open and on the existing 30s refresh push. No file watcher. |
| 15 | Cross-links: task title → workspace; sheet "View all activity for this rule →" → Activity pre-filtered; Activity rule name → Rules with the sheet open. Missing tasks render as plain text with the id in a tooltip. |
| 16 | Tests: units for the activity fold, the new commands, the CEL outline (including every shipped default rule) and the components/strings/degenerate states; **one e2e** for the wiring seam. |

### Domain language

The product word is **Rules**. "Automation" is the internal config field
(`config.automation`), never UI copy: the switch is "Rules on/off", the
banner says "Rules are turned off — they're loaded but never run."

### File header strings

Chosen by a `switch` on `RuleFile` fields (no interpretation of user input):

| `repositoryId` | `problems` | Header text after the file name |
|---|---|---|
| absent | empty | `· N rules · applies to every repository without an override` |
| absent | non-empty | `· not loaded · **repositories without an override currently have no rules**` |
| set | empty | `**{repo}** · N rules · replaces the global list for this repository` |
| set | non-empty | `**{repo}** · not loaded · **this repository currently has no rules at all**` |

`{repo}` is the repository label (`RepositoryLabel` engine), path shown
secondary in mono.

## Contract (core API)

`packages/core/src/contracts/rules.ts`:

```ts
/** How a rule's `if` reads, computed at parse time. */
export type RuleConditionView =
  | { kind: "always" }                                   // no `if`
  | { kind: "cel"; source: string; outline: CelOutline } // parsed OK
  | { kind: "cel-invalid"; source: string; error: string }
  | { kind: "js"; ref: string };                         // `js:./file.mjs#fn`

/**
 * Structure-only outline of a CEL expression: top-level `&&` chains become
 * `all`, `||` chains become `any` (same-operator chains flattened, parens
 * respected); everything else is a `leaf` whose `text` is a verbatim slice
 * of `source` (whitespace collapsed). Never paraphrases.
 */
export type CelOutline =
  | { kind: "all" | "any"; items: CelOutline[] }
  | { kind: "leaf"; text: string };

/** What a rule last did, within `RulesListing.activityWindowDays`. */
export interface RuleActivity {
  lastAt: string;              // ISO
  lastOutcome: RuleActionOutcome;
  lastDetail?: string;
  lastTaskId?: string;
  /** Actions audited for this rule in the window. */
  count: number;
}

export interface Rule {
  id: string;
  label: string;               // was optional; now required by the schema
  on: string[];
  if?: string;
  do: RuleActionSpec[];
  file: string;
  line: number;
  condition: RuleConditionView;
  /** Absent when the rule did nothing in the window. Filled by `listRules`. */
  activity?: RuleActivity;
}

export interface RuleFile {
  file: string;
  /** Absolute path, for "Open in editor" (`openIn`). */
  path: string;
  repositoryId?: string;
  rules: Rule[];
  problems: string[];
}

export interface RulesListing {
  files: RuleFile[];
  /** `config.automation`: whether rules run at all. */
  enabled: boolean;
  activityWindowDays: number;  // 30
}

export interface ListEventsFilter {
  taskId?: string;
  ruleId?: string;             // new: actions/warnings of this rule
  file?: string;               // new: with ruleId, disambiguates overrides
  since?: string;
  limit?: number;
}
```

`packages/core/src/contracts/commands.ts`:

```ts
/** Flip `config.automation`; the next refresh honours it. */
setRulesEnabled(enabled: boolean): Promise<void>;
```

Layering: the activity fold is an engine function
(`engines/rules/activity.ts`, pure, over `AuditEntry[]`); `listRules` in the
manager reads the window from `AuditLogAccess` and applies it. The outline
is an engine function (`engines/rules/outline.ts`) over the
`@marcbachmann/cel-js` AST, called from `parseRuleFile`. The CLI's
`harbormaster rules list` prints label and last fired from the same
listing.

### Schema change: `label` is required

`rules.schema.json` / `rules-schema.ts`: `label` moves into `required`
(`minLength: 1`). A rule without one is a validation problem ("rule
`<id>`: `label` is required"), so the file does not load. The shipped
defaults already carry labels; **users whose `rules.yaml` predates labels
will see the file as not loaded until they add them** (the page header
says exactly that).

## Renderer

- `View` gains `"rules"`; `Sidebar` gets the row; `App` handles ⌘⇧R.
- `components/RulesView.tsx` (top bar with tabs + switch, list, sheet),
  `components/RuleSheet.tsx`, `components/RulesActivity.tsx`,
  `lib/rules-format.ts` (row chips, header strings, relative times —
  pure, unit-tested). Reuse `audit-lines.ts` for activity rows.
- Data: `listRules()` on open and on the 30s refresh push;
  `listEvents({ruleId, file, limit: 5})` for the sheet;
  `listEvents({since})` for the Activity tab (client-side filters).
- "Open in editor" → `openIn(file.path, defaultApp)` via the existing
  open-in picker; "Open rules folder" → the parent directory.

## Tests

- core: `engines/rules/activity.test.ts`, `engines/rules/outline.test.ts`
  (table incl. all shipped default rules, nested groups, parse error,
  `js:`), manager tests for `listRules` enrichment, `listEvents` filters,
  `setRulesEnabled`, schema `label` required.
- app units: `rules-format.test.ts` (four header strings, chip collapse,
  dot mapping), component tests for the three degenerate states.
- e2e `rules.spec.ts` (one launch): sidebar + ⌘⇧R open the page; shipped
  rules listed under the global header; click → sheet shows On/If/Do;
  Activity tab lists a seeded action; task link opens the workspace.
  Proven to fail with the page reverted.
