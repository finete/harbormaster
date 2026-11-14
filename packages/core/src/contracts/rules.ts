// Rules-engine contracts (docs/release-plan.md "Rules engine"): board
// automation as event → condition → action. A **source** produces
// **events** (CloudEvents 1.0 envelopes), a **rule** has an event filter
// (`on`), a **condition** (`if`, CEL or a JS escape hatch) and **actions**
// (`do`). Plain types only; the engine lives in engines/rules/, the tick in
// manager/rules-runtime.ts, persistence in access/.

import type {
  AwaitingKindId,
  PullRequestRole,
  TaskKind,
  TaskPullRequest,
  TaskState,
} from "./model.js";

// --- Events -------------------------------------------------------------

/**
 * A CloudEvents 1.0 JSON envelope. `source` is the producing source id
 * (`github`, `version-endpoint`, `harbormaster`, or an addon's id);
 * `source` + `id` dedupes. `subject` is `task/<id>` when the event is about
 * a task, absent (or another subject form) otherwise.
 */
export interface CloudEvent<T = unknown> {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string;
  /** ISO timestamp. */
  time: string;
  datacontenttype?: "application/json";
  data?: T;
}

/** Payload of a snapshot-diff `<source>.<entity>.<field>Changed` event. */
export interface FieldChange {
  from: unknown;
  to: unknown;
}

// --- Sources ------------------------------------------------------------

/** JSON Schema object (draft-07), kept opaque at the type level. */
export type JsonSchema = Record<string, unknown>;

/**
 * The current facts about one subject as a source sees it. Core diffs each
 * new snapshot against the persisted previous one into
 * `<source>.<entity>.<field>Changed` ({from, to}) plus
 * `<source>.<entity>.appeared` / `.disappeared` events.
 */
export interface Snapshot {
  /** `task/<id>` for task-bound facts; any stable string otherwise (e.g. `repo/<id>/stage/<stage>`). */
  subject: string;
  /** Event-type segment: `github` + `pr` → `github.pr.*`. */
  entity: string;
  /** JSON-serializable facts; one key per diffable field. */
  facts: Record<string, unknown>;
  /**
   * The source could not observe this subject this time (an API error):
   * keep the previous facts, emit nothing. `facts` is ignored.
   */
  stale?: boolean;
}

/** An event a source pushes natively (`subscribe`); core fills the envelope. */
export interface SourceEmit {
  type: string;
  /** Source-scoped id used for dedupe; generated when absent. */
  id?: string;
  subject?: string;
  time?: string;
  data?: unknown;
}

/** One configured deployment stage as rules and sources see it. */
export interface RuleStageView {
  id: string;
  label: string;
  /** Source id that decides when this stage's wait is over (absent = manual gate). */
  hook?: string;
  options: Record<string, unknown>;
}

/** A repository as rules and sources see it (`repo` in CEL). */
export interface RuleRepoView {
  id: string;
  deployment: { stages: RuleStageView[] };
}

/** A task as rules and sources see it (`task` in CEL). Absent fields are `null`, never missing. */
export interface RuleTaskView {
  id: string;
  title: string;
  kind: TaskKind;
  state: TaskState;
  /** The awaiting record (`kind` plus its fields), `null` outside Awaiting. */
  awaiting: ({ kind: string } & Record<string, unknown>) | null;
  branch: string | null;
  /** Repository id (`github.com/org/repo`), `null` for repository-less tasks. */
  repository: string | null;
  /** The task's PR with its `role` resolved (`author` unless known otherwise), `null` without one. */
  pr: (TaskPullRequest & { role: PullRequestRole }) | null;
  parentTaskId: string | null;
  createdAt: string;
  stateChangedAt: string;
}

/** I/O a built-in or addon source may use; core wires these to its access layer. */
export interface SourceServices {
  github: {
    /**
     * The PR status this refresh tick observed for a task: `undefined` when
     * it was not observed (lookup failed or not a candidate), `{ status:
     * undefined }` when it has no PR.
     */
    observed(taskId: string): { status?: SourcePullRequestFacts } | undefined;
    /** Whether `ancestorOid` is contained in `descendantOid` (memoized). */
    containsCommit(
      repositoryId: string,
      ancestorOid: string,
      descendantOid: string,
    ): Promise<boolean>;
    /** Newest-first commits reachable from `startOid` (memoized; ≤ 100). */
    commitLog(
      repositoryId: string,
      startOid: string,
      limit: number,
    ): Promise<Array<{ oid: string; subject: string }>>;
    /** Open PRs matching a GitHub search query (`review-requested:@me`, `mentions:@me`); absent when the backend cannot search. */
    searchPullRequests?(query: string): Promise<SearchedPullRequest[]>;
  };
  http: {
    /** GET a small text document (cached ~5 minutes per URL). */
    fetchText(url: string): Promise<string>;
  };
}

/** What the github source reads per observed PR (a superset of `PullRequestStatus`). */
export interface SourcePullRequestFacts {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  reviewDecision?: string;
  changesRequestedOnHead?: boolean;
  humanFeedbackOnHead?: boolean;
  reviewRequested: boolean;
  reviewSubmitted: boolean;
  headRefOid?: string;
  mergeCommit?: { oid: string; targetBranch?: string };
  mergedAt?: string;
  closed?: boolean;
  author?: string;
  viewerIsAuthor?: boolean;
  checks?: string;
  unresolvedThreads?: number;
  lastAuthorActivityAt?: string;
  lastReviewerActivityAt?: string;
}

/** One PR from a GitHub search (unbound github facts). */
export interface SearchedPullRequest {
  /** `github.com/org/repo` */
  repository: string;
  number: number;
  url: string;
  title: string;
  author?: string;
  updatedAt?: string;
}

/** Everything a source's `snapshot` / `subscribe` is handed. */
export interface SourceContext {
  now(): Date;
  /** Every non-archived task. */
  tasks: readonly RuleTaskView[];
  /** Configured repositories (with their deployment pipelines). */
  repositories: readonly RuleRepoView[];
  /** `config.sources.<id>.settings`, validated against `settingsSchema` (empty when unset). */
  settings: Readonly<Record<string, unknown>>;
  /** The previous snapshot core persisted for this source. */
  previous: readonly Snapshot[];
  /** The cursor this source persisted last time (`setCursor`), if any. */
  cursor: unknown;
  setCursor(cursor: unknown): void;
  services: SourceServices;
  /** Report a problem observing something (surfaces as a refresh warning). */
  warn(message: string): void;
}

/**
 * An event source. Built-in sources (`harbormaster`, `github`,
 * `version-endpoint`) and addon sources share this shape.
 */
export interface Source {
  id: string;
  /** ms between snapshot polls; `0` = every refresh tick; absent = push only. */
  interval?: number;
  snapshot?(ctx: SourceContext): Promise<Snapshot[]>;
  /** Native push (webhooks, sockets); returns the unsubscribe. */
  subscribe?(emit: (event: SourceEmit) => void, ctx: SourceContext): () => void;
  /** JSON Schema for `config.sources.<id>.settings`. */
  settingsSchema?: JsonSchema;
}

// --- Rules --------------------------------------------------------------

/** One `do` entry as written in YAML. */
export interface RuleActionSpec {
  /** `move` | `inbox` | `createTask` | `message`, or `js:./file.mjs#fn`. */
  action: string;
  with?: Record<string, unknown>;
  /** 1-based line in the rules file. */
  line?: number;
}

/** How a rule's `if` reads, computed at parse time. */
export type RuleConditionView =
  /** No `if`. */
  | { kind: "always" }
  /** Parsed OK. */
  | { kind: "cel"; source: string; outline: CelOutline }
  | { kind: "cel-invalid"; source: string; error: string }
  /** `js:./file.mjs#fn`. */
  | { kind: "js"; ref: string };

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
  /** ISO time of the latest audited action. */
  lastAt: string;
  lastOutcome: RuleActionOutcome;
  lastDetail?: string;
  lastTaskId?: string;
  /** Actions audited for this rule in the window. */
  count: number;
}

/** One rule as loaded (validated) from a rules file. */
export interface Rule {
  id: string;
  /** Short human tag ("Needs changes") for the Rules page and the audit log; required by the schema. */
  label: string;
  /** Exact event type or glob (`github.pr.*`, `*` = one segment, `**` = any). */
  on: string[];
  /** CEL expression, or `js:./file.mjs#fn`; absent = always. */
  if?: string;
  do: RuleActionSpec[];
  /** Rules-dir-relative file the rule came from (`rules.yaml`, `repos/<repo>.yaml`). */
  file: string;
  /** 1-based line of the rule in that file. */
  line: number;
  /** How the `if` reads (structure-only CEL outline, raw `js:` ref, or the parse error). */
  condition: RuleConditionView;
  /** Absent when the rule did nothing in the window. Filled by `listRules`. */
  activity?: RuleActivity;
}

/** One parsed rules file. */
export interface RuleFile {
  file: string;
  /** Absolute path, for "Open in editor" (`openIn`). */
  path: string;
  /** Set for `repos/<repo>.yaml`: this list replaces the global one for that repository. */
  repositoryId?: string;
  rules: Rule[];
  /** Load/validation problems; a file with problems contributes no rules. */
  problems: string[];
}

/** `move` action input. */
export interface MoveActionInput {
  to: "dev" | "done" | "await";
  /** Awaiting kind for `to: await`; default `review`. */
  kind?: AwaitingKindId;
  /** Kind inputs; for `deploy`, `stage` picks a stage id (default: the entry stage). */
  input?: Record<string, string>;
  /** Run the kind's `onEnter` side effect (push/open PR, squash-merge). Default false: rules only move. */
  enter?: boolean;
}

/** `inbox` action input. */
export interface InboxActionInput {
  title: string;
  body?: string;
  /** `false` files the item under Other instead of Priority (default true). */
  priority?: boolean;
  buttons?: Array<{
    label: string;
    action: "openTask" | "createTask" | "dismiss" | "snooze";
    with?: Record<string, unknown>;
  }>;
}

/** `createTask` action input. */
export interface CreateTaskActionInput {
  title: string;
  prompt?: string;
  /** Repository id; derived from `pr` when it is a URL. */
  repository?: string;
  /** PR number or URL. */
  pr?: number | string;
  role?: PullRequestRole;
  start?: boolean;
}

/** `message` action input: a message to the event's task (or `to`). */
export interface MessageActionInput {
  text: string;
  mode?: "steer" | "followUp";
  /** Target task id; default the event's task. */
  to?: string;
}

/** The variables a condition / template sees. */
export interface RuleVariables {
  event: CloudEvent;
  task: RuleTaskView | null;
  /** `facts.<source>`: that source's current facts for the event's subject task (or subject); `{}` when none. */
  facts: Record<string, Record<string, unknown>>;
  repo: RuleRepoView | null;
}

// --- Audit log ----------------------------------------------------------

export type RuleActionOutcome =
  /** The action ran. */
  | "applied"
  /** A move whose execution was refused (e.g. auto-landing a dirty worktree); retried next tick. */
  | "stayed"
  /** A move that lost arbitration to an earlier rule this tick. */
  | "superseded"
  /** Not executed (illegal or no-op move, no task). */
  | "skipped"
  /** Threw; no-op. */
  | "failed";

interface AuditBase {
  /** ISO time the entry was recorded. */
  at: string;
  taskId?: string;
}

export interface AuditEventEntry extends AuditBase {
  kind: "event";
  event: CloudEvent;
}

export interface AuditActionEntry extends AuditBase {
  kind: "action";
  ruleId: string;
  file: string;
  line: number;
  eventId: string;
  eventType: string;
  /** The rule's `label` when it fired (absent in older entries or unlabeled rules). */
  ruleLabel?: string;
  /** `move` / `inbox` / `createTask` / `message` / `js:…`. */
  action: string;
  /** Rendered (templated) input. */
  with?: Record<string, unknown>;
  /** Where a `move` started: the task's column (and awaiting kind) before it ran. */
  from?: { state: TaskState; awaitingKind?: string };
  outcome: RuleActionOutcome;
  detail?: string;
}

export interface AuditWarningEntry extends AuditBase {
  kind: "warning";
  message: string;
  ruleId?: string;
  file?: string;
  line?: number;
  eventId?: string;
}

/** One line of `<stateDir>/events/YYYY-MM-DD.jsonl`. */
export type AuditEntry = AuditEventEntry | AuditActionEntry | AuditWarningEntry;

// --- Commands -----------------------------------------------------------

export interface ListEventsFilter {
  /** Keep entries about this task (events with subject `task/<id>`, actions/warnings on it). */
  taskId?: string;
  /** Keep this rule's actions and warnings (events are dropped). */
  ruleId?: string;
  /** Keep actions/warnings from this rules-dir-relative file; with `ruleId` it disambiguates overrides. */
  file?: string;
  /** ISO time (or `YYYY-MM-DD`); entries at or after it. */
  since?: string;
  /** Newest N entries (default 500), returned oldest first. */
  limit?: number;
}

export interface RulesCheckInput {
  taskId?: string;
  /** ISO time (or `YYYY-MM-DD`) to replay recorded events from; default: everything retained. */
  replayFrom?: string;
}

/** What `rulesCheck` says one rule action would do for one recorded event. */
export interface RulesCheckPlan {
  eventId: string;
  eventType: string;
  eventTime: string;
  taskId?: string;
  ruleId: string;
  file: string;
  line: number;
  action: string;
  with?: Record<string, unknown>;
  /** `would-run` (non-move), `would-move`, `superseded` (lost arbitration), `skipped` (illegal/no-op move). */
  outcome: "would-run" | "would-move" | "superseded" | "skipped";
  detail?: string;
}

export interface RulesCheckResult {
  /** Recorded events replayed. */
  events: number;
  plans: RulesCheckPlan[];
  /** Condition errors, invalid rule files, unknown tasks. */
  warnings: string[];
}

/** `listRules` result: every rules file as currently loaded. */
export interface RulesListing {
  files: RuleFile[];
  /** `config.automation`: whether rules run at all. */
  enabled: boolean;
  /** Days of audit log folded into each rule's `activity` (30). */
  activityWindowDays: number;
}

// --- Addons -------------------------------------------------------------

/** An awaiting kind an addon declares (data only; see `listAddons`). */
export interface AddonAwaitingKind {
  id: string;
  label: string;
  description?: string;
}

/** `<stateDir>/addons/<name>/addon.json`. */
export interface AddonManifest {
  name: string;
  version: string;
  description?: string;
  provides: {
    /** Source ids `source.mjs` exports. */
    sources?: string[];
    awaitingKinds?: AddonAwaitingKind[];
    /** Addon-dir-relative YAML file of suggested rules (never active by themselves). */
    rules?: string;
  };
}

/** One addon (built-in or user) as `listAddons` reports it. */
export interface AddonInfo {
  name: string;
  version: string;
  description?: string;
  /** Shipped inside core; listed as a read-only reference. */
  builtin: boolean;
  readOnly: boolean;
  sources: Array<{
    id: string;
    interval?: number;
    settingsSchema?: JsonSchema;
  }>;
  awaitingKinds: AddonAwaitingKind[];
  /** Suggested rules YAML, offered for copy into `rules/`; never active by itself. */
  suggestedRules?: string;
  /** False when the addon was skipped (broken manifest/module, shadowed id). */
  loaded: boolean;
  problems: string[];
}

// --- Access boundaries --------------------------------------------------

/** Persisted per-source state: last snapshot, cursor, dedupe window. */
export interface SourceState {
  subjects: Record<string, { entity: string; facts: Record<string, unknown> }>;
  cursor?: unknown;
  /** ISO time of the last successful poll. */
  polledAt?: string;
  /** Recently seen pushed event ids (dedupe window). */
  seen?: string[];
}

/** A move that did not apply yet (superseded/stayed/failed): re-evaluated next tick. */
export interface PendingRuleMove {
  ruleId: string;
  file: string;
  event: CloudEvent;
  taskId: string;
  /** Last audited outcome + detail, so a retry is audited only when it changes. */
  lastOutcome?: RuleActionOutcome;
  lastDetail?: string;
}

/** Resource Access: `<stateDir>/sources/` (JSON per source + the pending-move queue). */
export interface SourceStateAccess {
  read(sourceId: string): Promise<SourceState>;
  write(sourceId: string, state: SourceState): Promise<void>;
  readPending(): Promise<PendingRuleMove[]>;
  writePending(pending: PendingRuleMove[]): Promise<void>;
}

/** Resource Access: `<stateDir>/events/YYYY-MM-DD.jsonl` (append-only, rotated by day). */
export interface AuditLogAccess {
  append(entries: readonly AuditEntry[]): Promise<void>;
  /** Entries at or after `since` (ISO), oldest first. */
  read(since?: string): Promise<AuditEntry[]>;
}

/** One raw rules file. */
export interface RuleFileText {
  /** Rules-dir-relative path. */
  file: string;
  /** Absolute path of the file on disk. */
  path: string;
  repositoryId?: string;
  text: string;
}

/** Resource Access: `<stateDir>/rules/` (YAML files + JS escape-hatch modules). */
export interface RulesFileAccess {
  /** Whether the global `rules.yaml` exists. */
  hasGlobalRules(): Promise<boolean>;
  /** Write files (rules-dir-relative path → text) that do not exist yet. */
  writeDefaults(files: Readonly<Record<string, string>>): Promise<void>;
  /** Write Harbormaster-managed files (always overwritten; written only when the content differs). */
  writeManaged(files: Readonly<Record<string, string>>): Promise<void>;
  /** The global file (when present) and every `repos/**\/*.yaml`. */
  readRuleFiles(): Promise<RuleFileText[]>;
  /** Import a JS module from inside the rules dir (fresh after edits). */
  importModule(relativePath: string): Promise<Record<string, unknown>>;
}

/** One addon directory as found on disk. */
export interface DiscoveredAddon {
  /** Directory name under `<stateDir>/addons/`. */
  dirName: string;
  /** Parsed `addon.json` (unvalidated), when readable. */
  manifest?: unknown;
  /** `source.mjs`'s module namespace, when present and importable. */
  module?: Record<string, unknown>;
  /** The suggested-rules file text, when the manifest names one. */
  suggestedRules?: string;
  /** Read/import errors. */
  problems: string[];
}

/** Resource Access: `<stateDir>/addons/<name>/`. */
export interface AddonAccess {
  discover(): Promise<DiscoveredAddon[]>;
}
