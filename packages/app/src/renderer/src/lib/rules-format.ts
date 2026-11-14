// Pure wording and shaping for the Rules page (docs/rules-page.md): file
// group headers (four fixed strings), row chips (`on` globs collapsed past
// two, `do` actions), the row dot (last outcome), relative "last fired",
// load-problem lines, the Activity tab's filtering and day groups. The
// renderer only displays what core computed; nothing here interprets a
// rule's condition. Free of React (tests/rules-format.test.ts).
import type {
  AuditActionEntry,
  AuditEntry,
  RuleActionOutcome,
  RuleActionSpec,
  RuleActivity,
  RuleFile,
} from "../../../preload/api";
import { folderWhere } from "./new-task-draft";
import { relativeTime } from "./time-format";

// --- File group headers --------------------------------------------------

/** One run of header text; `strong` runs are bold (the decision table's **…**). */
export interface HeaderSegment {
  text: string;
  strong?: boolean;
}

/** Which of the four fixed headers a file gets (a switch on its fields only). */
export type FileHeaderKind =
  | "global-loaded"
  | "global-broken"
  | "repo-loaded"
  | "repo-broken";

export function fileHeaderKind(
  file: Pick<RuleFile, "repositoryId" | "problems">,
): FileHeaderKind {
  const broken = file.problems.length > 0;
  if (file.repositoryId === undefined) {
    return broken ? "global-broken" : "global-loaded";
  }
  return broken ? "repo-broken" : "repo-loaded";
}

function ruleCount(count: number): string {
  return `${count} ${count === 1 ? "rule" : "rules"}`;
}

/**
 * The header text after the file name, as segments. `repoLabel` is the
 * repository's display label (only used for `repos/<repo>.yaml`).
 */
export function fileHeaderSegments(
  file: Pick<RuleFile, "repositoryId" | "problems" | "rules">,
  repoLabel: string,
): HeaderSegment[] {
  switch (fileHeaderKind(file)) {
    case "global-loaded":
      return [
        {
          text: `· ${ruleCount(file.rules.length)} · applies to every repository without an override`,
        },
      ];
    case "global-broken":
      return [
        { text: "· not loaded · " },
        {
          text: "repositories without an override currently have no rules",
          strong: true,
        },
      ];
    case "repo-loaded":
      return [
        { text: repoLabel, strong: true },
        {
          text: ` · ${ruleCount(file.rules.length)} · replaces the global list for this repository`,
        },
      ];
    case "repo-broken":
      return [
        { text: repoLabel, strong: true },
        { text: " · not loaded · " },
        { text: "this repository currently has no rules at all", strong: true },
      ];
  }
}

/** The header as plain text (tests, tooltips). */
export function fileHeaderText(
  file: Pick<RuleFile, "repositoryId" | "problems" | "rules">,
  repoLabel: string,
): string {
  return fileHeaderSegments(file, repoLabel)
    .map((segment) => segment.text)
    .join("");
}

/**
 * A load problem as `line N · message`. Core reports `file:line: message`
 * (or `file: message` for YAML/schema errors without a line); anything
 * else is shown verbatim.
 */
export function problemLine(problem: string, file: string): string {
  const prefix = `${file}:`;
  const rest = problem.startsWith(prefix)
    ? problem.slice(prefix.length)
    : problem;
  const withLine = /^(\d+):\s*(.*)$/s.exec(rest);
  if (withLine) return `line ${withLine[1]} · ${withLine[2]}`;
  return rest === problem ? problem : rest.trimStart();
}

/** The rules folder, from any loaded file's absolute path (`<dir>/<file>`). */
export function rulesFolder(
  files: readonly Pick<RuleFile, "file" | "path">[],
): string | undefined {
  for (const file of files) {
    if (!file.path) continue;
    const suffix = `/${file.file}`;
    if (file.path.endsWith(suffix)) {
      return file.path.slice(0, file.path.length - suffix.length);
    }
  }
  return undefined;
}

// --- The top bar's Edit split button ------------------------------------

/** What the Edit button's main part does: open the composer, or open the folder in an app. */
export type RulesEditChoice = "chat" | "app";

/** localStorage key of the Edit button's last-used choice. */
export const RULES_EDIT_CHOICE_KEY = "harbormaster.rules.editWith";

type ChoiceStorage = Pick<Storage, "getItem" | "setItem">;

/** The last-used choice; Edit in chat until something else was used. */
export function readRulesEditChoice(storage: ChoiceStorage): RulesEditChoice {
  try {
    return storage.getItem(RULES_EDIT_CHOICE_KEY) === "app" ? "app" : "chat";
  } catch {
    return "chat";
  }
}

export function writeRulesEditChoice(
  storage: ChoiceStorage,
  choice: RulesEditChoice,
): void {
  try {
    storage.setItem(RULES_EDIT_CHOICE_KEY, choice);
  } catch {
    // Storage full/blocked: the choice just isn't remembered.
  }
}

/** The New task composer's prefill for "Edit in chat": Chat mode in the rules folder (the user reviews and launches it). */
export function rulesEditRequest(folder: string): {
  where: string;
  title: string;
  prompt: string;
  mode: "chat";
} {
  return {
    mode: "chat",
    where: folderWhere(folder),
    title: "Edit rules",
    prompt: `Edit my Harbormaster rules in ${folder}/rules.yaml (and repos/*.yaml). Read AGENTS.md in this folder first; it documents the rules language. After editing, validate with \`harbormaster rules list\` and \`harbormaster rules check\`.`,
  };
}

// --- Row chips -----------------------------------------------------------

/** `on` chips: at most two globs, the rest as `+N`. */
export function onChips(on: readonly string[]): {
  shown: string[];
  more: number;
} {
  return { shown: on.slice(0, 2), more: Math.max(0, on.length - 2) };
}

/** A `do` chip: `move → dev`, `move → await:review`, `inbox`, `createTask`, `message`, `js:…`. */
export function doChipText(
  spec: Pick<RuleActionSpec, "action" | "with">,
): string {
  if (spec.action !== "move") return spec.action;
  const to = typeof spec.with?.to === "string" ? spec.with.to : "?";
  if (to !== "await") return `move → ${to}`;
  const kind = typeof spec.with?.kind === "string" ? spec.with.kind : "review";
  return `move → await:${kind}`;
}

function shortValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/** The sheet's `with` summary: `to: dev · kind: review` (values flattened, long ones cut). */
export function withSummary(spec: Pick<RuleActionSpec, "with">): string {
  if (!spec.with) return "";
  return Object.entries(spec.with)
    .map(([key, value]) => `${key}: ${shortValue(value)}`)
    .join(" · ");
}

// --- Dot and times -------------------------------------------------------

/** The row dot: mint applied, amber stayed/superseded, red failed, grey otherwise. */
export type RuleDot = "ok" | "needsYou" | "error" | "none";

export function outcomeDot(outcome: RuleActionOutcome | undefined): RuleDot {
  switch (outcome) {
    case "applied":
      return "ok";
    case "stayed":
    case "superseded":
      return "needsYou";
    case "failed":
      return "error";
    default:
      return "none";
  }
}

export function ruleDot(activity: RuleActivity | undefined): RuleDot {
  return outcomeDot(activity?.lastOutcome);
}

/** Tailwind classes per dot (status-* tokens only). */
export const DOT_CLASS: Record<RuleDot, string> = {
  ok: "bg-status-ok",
  needsYou: "bg-status-needsYou",
  error: "bg-status-error",
  none: "bg-muted-foreground/40",
};

export const DOT_TITLE: Record<RuleDot, string> = {
  ok: "Last run applied",
  needsYou: "Last run did not apply (stayed or superseded)",
  error: "Last run failed",
  none: "Did nothing in the activity window",
};

/** "2h ago" / "just now" / "never". */
export function lastFiredText(
  activity: RuleActivity | undefined,
  now: number,
): string {
  if (!activity) return "never";
  const age = relativeTime(activity.lastAt, now);
  if (!age) return "";
  return age === "now" ? "just now" : `${age} ago`;
}

// --- Selection -----------------------------------------------------------

/** A rule's identity on the page: rule ids repeat across files. */
export interface RuleKey {
  file: string;
  ruleId: string;
}

export function ruleKeyString(key: RuleKey): string {
  return `${key.file}#${key.ruleId}`;
}

/** ↑/↓ in the flat row order; from nothing, ↓ picks the first and ↑ the last. */
export function moveRuleSelection(
  order: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const index = current ? order.indexOf(current) : -1;
  if (index < 0)
    return delta === 1 ? (order[0] ?? null) : (order.at(-1) ?? null);
  const next = Math.min(order.length - 1, Math.max(0, index + delta));
  return order[next] ?? null;
}

// --- Activity tab --------------------------------------------------------

export interface ActivityFilter {
  rule?: RuleKey;
  taskId?: string;
  outcome?: RuleActionOutcome;
}

/**
 * Activity rows, newest first: actions and warnings, plus raw events when
 * `showEvents`. Filters (rule, task, outcome) are client-side; an outcome
 * filter keeps actions only, a rule filter keeps that rule's actions and
 * warnings.
 */
export function activityEntries(
  entries: readonly AuditEntry[],
  filter: ActivityFilter,
  showEvents: boolean,
): AuditEntry[] {
  return entries
    .filter((entry) => {
      if (entry.kind === "event" && !showEvents) return false;
      if (filter.taskId) {
        const about =
          entry.taskId === filter.taskId ||
          (entry.kind === "event" &&
            entry.event.subject === `task/${filter.taskId}`);
        if (!about) return false;
      }
      if (filter.rule) {
        if (entry.kind === "event") return false;
        if (entry.ruleId !== filter.rule.ruleId) return false;
        if (entry.file !== undefined && entry.file !== filter.rule.file) {
          return false;
        }
      }
      if (filter.outcome) {
        if (entry.kind !== "action" || entry.outcome !== filter.outcome) {
          return false;
        }
      }
      return true;
    })
    .reverse();
}

/** The triggering event of an action, by `eventId`, from the same result set. */
export function triggeringEvent(
  action: AuditActionEntry,
  entries: readonly AuditEntry[],
): AuditEntry | undefined {
  return entries.find(
    (entry) => entry.kind === "event" && entry.event.id === action.eventId,
  );
}

/** Local `YYYY-MM-DD` of an ISO time (day group key). */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "Today" / "Yesterday" / "Mon, Nov 10". */
export function dayLabel(key: string, now: number): string {
  if (key === dayKey(new Date(now).toISOString())) return "Today";
  if (key === dayKey(new Date(now - 86_400_000).toISOString())) {
    return "Yesterday";
  }
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Group newest-first entries by local day, keeping order. */
export function groupByDay<T extends { at: string }>(
  entries: readonly T[],
): Array<{ day: string; entries: T[] }> {
  const groups: Array<{ day: string; entries: T[] }> = [];
  for (const entry of entries) {
    const day = dayKey(entry.at);
    const last = groups.at(-1);
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

/** ISO time `days` days before `now` (the Activity tab's `since`). */
export function sinceDaysAgo(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/** What the page shows instead of (or above) the list. */
export type RulesPageState = "no-files" | "only-broken" | "list";

export function rulesPageState(files: readonly RuleFile[]): RulesPageState {
  if (files.length === 0) return "no-files";
  if (files.every((file) => file.problems.length > 0)) return "only-broken";
  return "list";
}
