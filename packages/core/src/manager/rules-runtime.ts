// Manager-side workflow of the rules engine: one refresh tick = poll the
// due sources → diff snapshots into events (plus natively pushed events) →
// audit → match rules → arbitrate → execute through core commands → audit
// outcomes. Owned by CoreManager (which supplies the action executor, i.e.
// its own moveTask/toAwait/toDone/createTask/sendTaskMessage), so this is
// not a second client-facing Manager. Runs only from `refresh()`, which
// only the app calls: the single automation host.
//
// Moves that did not apply (superseded by an earlier rule, refused, or
// failed) are kept in a persisted pending queue and re-evaluated against
// fresh state on the next tick — the level-triggered behavior the retired
// movers had ("deployed and ready to land" retries until it lands).

import type { GlobalConfig, Task } from "../contracts/model.js";
import type {
  AddonAccess,
  AddonInfo,
  AuditActionEntry,
  AuditEntry,
  AuditLogAccess,
  CloudEvent,
  CreateTaskActionInput,
  InboxActionInput,
  ListEventsFilter,
  MessageActionInput,
  PendingRuleMove,
  RuleFile,
  RuleFileText,
  RuleRepoView,
  RulesCheckInput,
  RulesCheckPlan,
  RulesCheckResult,
  RulesFileAccess,
  RulesListing,
  RuleVariables,
  Snapshot,
  Source,
  SourceContext,
  SourceEmit,
  SourcePullRequestFacts,
  SourceServices,
  SourceState,
  SourceStateAccess,
} from "../contracts/rules.js";
import type { ConfigAccess } from "../contracts/services.js";
import { builtinAwaitingKinds } from "../engines/awaiting-kinds.js";
import { validateAddons } from "../engines/rules/addons.js";
import { defaultRulesYaml } from "../engines/rules/default-rules.js";
import {
  type EvaluationContext,
  matchRules,
  moveRefusal,
  type PlannedRuleAction,
  planActions,
  type ResolvedMove,
  type RuleWarning,
} from "../engines/rules/evaluation.js";
import {
  GLOBAL_RULES_FILE,
  parseRuleFile,
  repositoryRulesFile,
} from "../engines/rules/rule-files.js";
import {
  diffSnapshots,
  taskIdOfSubject,
} from "../engines/rules/snapshot-diff.js";
import { sourceSettingsProblems } from "../engines/rules/source-settings.js";
import {
  automationConfigProblems,
  repositoryViews,
  toRuleRepoView,
  toRuleTaskView,
} from "../engines/rules/views.js";
import {
  BUILTIN_ADDON_NAME,
  builtinSources,
} from "../engines/sources/index.js";
import { UuidGenerator } from "../utilities/defaults.js";

/** What executing one action did. */
export interface ActionResult {
  outcome: "applied" | "stayed" | "skipped";
  detail?: string;
}

/** Provenance handed to every executed action. */
export interface ActionProvenance {
  ruleId: string;
  eventId: string;
  /** The event's source (`github`, an addon id). */
  source?: string;
  taskId?: string;
}

/** Core commands the rules call; implemented by CoreManager. */
export interface RuleActionExecutor {
  move(
    task: Task,
    move: ResolvedMove,
    protectedPaths: readonly string[],
    warnings: string[],
  ): Promise<ActionResult>;
  inbox(
    input: InboxActionInput,
    provenance: ActionProvenance,
  ): Promise<ActionResult>;
  createTask(
    input: CreateTaskActionInput,
    provenance: ActionProvenance,
  ): Promise<ActionResult>;
  message(
    input: MessageActionInput,
    provenance: ActionProvenance,
  ): Promise<ActionResult>;
}

export interface RulesRuntimeDependencies {
  rules: RulesFileAccess;
  state: SourceStateAccess;
  audit: AuditLogAccess;
  addons?: AddonAccess;
  config: ConfigAccess;
  now(): Date;
  /** Source I/O minus the per-tick PR observations (added per tick). */
  services: {
    github: Omit<SourceServices["github"], "observed">;
    http: SourceServices["http"];
  };
}

export interface RulesTickInput {
  tasks: readonly Task[];
  config: GlobalConfig;
  /** This tick's PR observations by task id (see SourceServices.github.observed). */
  observed: ReadonlyMap<string, { status?: unknown }>;
  protectedPaths: readonly string[];
  executor: RuleActionExecutor;
}

export interface RulesTickResult {
  /** Problems to surface as refresh warnings (already deduplicated where noisy). */
  warnings: string[];
  /** Source observation failures (connectivity-classified by the caller). */
  sourceFailures: string[];
  /** Whether any action changed the board. */
  changed: boolean;
}

const SEEN_WINDOW = 500;

export class RulesRuntime {
  private readonly eventIds = new UuidGenerator();
  /** Built-in source ids plus loaded addon source ids (stage hooks may name any). */
  private known: ReadonlySet<string> = new Set(
    builtinSources.map((source) => source.id),
  );
  private defaultsEnsured = false;
  private addonLoad:
    | Promise<{ sources: Source[]; infos: AddonInfo[]; problems: string[] }>
    | undefined;
  private readonly parsedFiles = new Map<string, RuleFile>();
  /** Problems already reported once (rule files, addons, settings, config). */
  private readonly reported = new Set<string>();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly pushed: Array<{ source: string; event: SourceEmit }> = [];

  constructor(private readonly deps: RulesRuntimeDependencies) {}

  /** One automation tick. Never throws for a rule/source problem. */
  async tick(input: RulesTickInput): Promise<RulesTickResult> {
    const warnings: string[] = [];
    const sourceFailures: string[] = [];
    await this.ensureDefaultRules(warnings);
    const files = await this.loadRuleFiles(warnings);
    const sources = await this.activeSources(input.config, warnings);
    const known = new Set(sources.all.map((source) => source.id));
    this.reportOnce(warnings, automationConfigProblems(input.config, known));

    const liveTasks = input.tasks.filter((task) => !task.archivedAt);
    const taskViews = liveTasks.map(toRuleTaskView);
    const repositories = repositoryViews(input.config, known);
    const now = this.deps.now();
    const time = now.toISOString();
    const services: SourceServices = {
      github: {
        ...this.deps.services.github,
        observed: (taskId) =>
          input.observed.get(taskId) as
            | { status?: SourcePullRequestFacts }
            | undefined,
      },
      http: this.deps.services.http,
    };

    // 1. Sources → events (snapshot diffs + pushed events).
    const events: CloudEvent[] = [];
    const states = new Map<string, SourceState>();
    for (const source of sources.all) {
      const state = await this.deps.state.read(source.id);
      states.set(source.id, state);
      if (!sources.enabled.has(source.id)) continue;
      const settings = input.config.sources?.[source.id]?.settings ?? {};
      let cursor = state.cursor;
      const context: SourceContext = {
        now: () => now,
        tasks: taskViews,
        repositories,
        settings,
        previous: Object.entries(state.subjects).map(([subject, entry]) => ({
          subject,
          entity: entry.entity,
          facts: entry.facts,
        })),
        cursor,
        setCursor: (next) => {
          cursor = next;
        },
        services,
        warn: (message) => sourceFailures.push(message),
      };
      this.ensureSubscribed(source, context, warnings);
      const nextState: SourceState = { ...state };
      let dirty = false;
      if (source.snapshot && isDue(source, state, now)) {
        let snapshots: Snapshot[] | undefined;
        try {
          snapshots = await source.snapshot(context);
        } catch (error) {
          sourceFailures.push(`Source ${source.id}: ${describe(error)}`);
        }
        if (snapshots) {
          const diff = diffSnapshots(
            source.id,
            state.subjects,
            snapshots,
            time,
            () => this.eventIds.next(),
          );
          events.push(...diff.events);
          nextState.subjects = diff.subjects;
          nextState.polledAt = time;
          dirty = true;
        }
      }
      const pushed = this.drainPushed(source.id, nextState, time);
      if (pushed.length > 0) {
        events.push(...pushed);
        dirty = true;
      }
      if (cursor !== state.cursor) {
        nextState.cursor = cursor;
        dirty = true;
      }
      if (dirty) {
        await this.deps.state.write(source.id, nextState);
        states.set(source.id, nextState);
      }
    }

    // 2. Audit every event, then evaluate.
    const audit: AuditEntry[] = events.map((event): AuditEntry => {
      const taskId = taskIdOfSubject(event.subject);
      return { kind: "event", at: time, ...(taskId ? { taskId } : {}), event };
    });
    const tasksById = new Map(liveTasks.map((task) => [task.id, task]));
    const context = this.evaluationContext(
      files,
      tasksById,
      states,
      input.config,
      known,
    );
    const pending = await this.deps.state.readPending();
    const pendingByKey = new Map(
      pending.map((entry) => [pendingKey(entry.ruleId, entry.taskId), entry]),
    );
    const matched = await matchRules(events, pending, context);
    this.auditWarnings(matched.warnings, time, audit, warnings);
    const planned = await planActions(matched.candidates, context);
    this.auditWarnings(planned.warnings, time, audit, warnings);

    // 3. Execute.
    let changed = false;
    const nextPending = new Map<string, PendingRuleMove>();
    for (const action of planned.actions) {
      const result = await this.execute(action, tasksById, input, warnings);
      if (result.outcome === "applied" && action.action !== "inbox") {
        changed = true;
      }
      const taskId = action.candidate.taskId;
      const key = taskId ? pendingKey(action.candidate.rule.id, taskId) : "";
      const previous = key ? pendingByKey.get(key) : undefined;
      const retryRepeat =
        action.candidate.retry &&
        previous?.lastOutcome === result.outcome &&
        previous?.lastDetail === result.detail;
      if (!retryRepeat) {
        audit.push(actionEntry(action, result, time));
      }
      if (
        action.action === "move" &&
        taskId &&
        (result.outcome === "superseded" ||
          result.outcome === "stayed" ||
          result.outcome === "failed")
      ) {
        nextPending.set(key, {
          ruleId: action.candidate.rule.id,
          file: action.candidate.rule.file,
          event: action.candidate.event,
          taskId,
          lastOutcome: result.outcome,
          ...(result.detail !== undefined ? { lastDetail: result.detail } : {}),
        });
      }
    }
    if (pending.length > 0 || nextPending.size > 0) {
      await this.deps.state.writePending([...nextPending.values()]);
    }
    await this.deps.audit.append(audit);
    return { warnings, sourceFailures, changed };
  }

  /** `rulesCheck`: current rules over recorded events, nothing executed. */
  async check(
    input: RulesCheckInput,
    tasks: readonly Task[],
    config: GlobalConfig,
  ): Promise<RulesCheckResult> {
    const warnings: string[] = [];
    const files = await this.loadRuleFiles(warnings, true);
    const sources = await this.activeSources(config, warnings, true);
    const known = new Set(sources.all.map((source) => source.id));
    const states = new Map<string, SourceState>();
    for (const source of sources.all) {
      states.set(source.id, await this.deps.state.read(source.id));
    }
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const context = this.evaluationContext(
      files,
      tasksById,
      states,
      config,
      known,
    );
    const recorded = (
      await this.deps.audit.read(normalizeSince(input.replayFrom))
    ).filter(
      (entry): entry is Extract<AuditEntry, { kind: "event" }> =>
        entry.kind === "event" &&
        (!input.taskId || entry.event.subject === `task/${input.taskId}`),
    );
    const plans: RulesCheckPlan[] = [];
    for (const { event } of recorded) {
      const matched = await matchRules([event], [], context);
      const planned = await planActions(matched.candidates, context);
      for (const warning of [...matched.warnings, ...planned.warnings]) {
        warnings.push(warning.message);
      }
      for (const action of planned.actions) {
        plans.push({
          eventId: event.id,
          eventType: event.type,
          eventTime: event.time,
          ...(action.candidate.taskId
            ? { taskId: action.candidate.taskId }
            : {}),
          ruleId: action.candidate.rule.id,
          file: action.candidate.rule.file,
          line: action.line,
          action: action.action,
          with: action.with,
          outcome:
            action.status === "run"
              ? action.action === "move"
                ? "would-move"
                : "would-run"
              : action.status === "superseded"
                ? "superseded"
                : "skipped",
          ...(action.detail ? { detail: action.detail } : {}),
        });
      }
    }
    return { events: recorded.length, plans, warnings };
  }

  async listEvents(filter: ListEventsFilter = {}): Promise<AuditEntry[]> {
    const entries = (
      await this.deps.audit.read(normalizeSince(filter.since))
    ).filter(
      (entry) =>
        !filter.taskId ||
        entry.taskId === filter.taskId ||
        (entry.kind === "event" &&
          entry.event.subject === `task/${filter.taskId}`),
    );
    const limit = filter.limit ?? 500;
    return entries.slice(Math.max(0, entries.length - limit));
  }

  /** Pending `move: done` retries whose last outcome was `stayed` (landing refused). */
  async listStayedLandings(): Promise<
    Array<{ taskId: string; ruleId: string; detail?: string; at: string }>
  > {
    const pending = await this.deps.state.readPending();
    return pending.flatMap((entry) =>
      entry.lastOutcome === "stayed"
        ? [
            {
              taskId: entry.taskId,
              ruleId: entry.ruleId,
              ...(entry.lastDetail ? { detail: entry.lastDetail } : {}),
              at: entry.event.time,
            },
          ]
        : [],
    );
  }

  async listRules(): Promise<RulesListing> {
    return { files: await this.loadRuleFiles([], true) };
  }

  async listAddons(): Promise<AddonInfo[]> {
    const loaded = await this.loadAddons();
    const builtin: AddonInfo = {
      name: BUILTIN_ADDON_NAME,
      version: "1",
      description:
        "Sources shipped with Harbormaster: the board itself, GitHub pull requests, deployment version endpoints.",
      builtin: true,
      readOnly: true,
      sources: builtinSources.map((source) => ({
        id: source.id,
        ...(source.interval !== undefined ? { interval: source.interval } : {}),
        ...(source.settingsSchema
          ? { settingsSchema: source.settingsSchema }
          : {}),
      })),
      awaitingKinds: builtinAwaitingKinds.map((kind) => ({
        id: kind.id,
        label: kind.label,
        description: kind.description,
      })),
      suggestedRules: defaultRulesYaml(),
      loaded: true,
      problems: [],
    };
    return [builtin, ...loaded.infos];
  }

  /** Source ids a deployment stage's `hook` may name (built-ins + loaded addons). */
  knownSourceIds(): ReadonlySet<string> {
    return this.known;
  }

  /** Stop native subscriptions (app quit). */
  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      try {
        unsubscribe();
      } catch {
        // best effort
      }
    }
    this.subscriptions.clear();
  }

  // --- internals --------------------------------------------------------

  private async ensureDefaultRules(warnings: string[]): Promise<void> {
    if (this.defaultsEnsured) return;
    try {
      if (!(await this.deps.rules.hasGlobalRules())) {
        const legacy = (await this.deps.config.legacyMoverOrders?.()) ?? {
          repositories: {},
        };
        const files: Record<string, string> = {
          [GLOBAL_RULES_FILE]: defaultRulesYaml(legacy.global),
        };
        for (const [repositoryId, movers] of Object.entries(
          legacy.repositories,
        )) {
          if (repositoryId.split("/").includes("..")) continue;
          files[repositoryRulesFile(repositoryId)] = defaultRulesYaml(movers);
        }
        await this.deps.rules.writeDefaults(files);
      }
      this.defaultsEnsured = true;
    } catch (error) {
      this.reportOnce(warnings, [
        `Could not write the default rules: ${describe(error)}`,
      ]);
    }
  }

  private async loadRuleFiles(
    warnings: string[],
    quiet = false,
  ): Promise<RuleFile[]> {
    let texts: RuleFileText[];
    try {
      texts = await this.deps.rules.readRuleFiles();
    } catch (error) {
      if (!quiet) {
        this.reportOnce(warnings, [`Could not read rules: ${describe(error)}`]);
      }
      return [];
    }
    const files: RuleFile[] = [];
    for (const text of texts) {
      const key = `${text.file}\u0000${text.text}`;
      let parsed = this.parsedFiles.get(key);
      if (!parsed) {
        parsed = parseRuleFile(text);
        this.parsedFiles.set(key, parsed);
        if (this.parsedFiles.size > 200) {
          const oldest = this.parsedFiles.keys().next().value;
          if (oldest !== undefined) this.parsedFiles.delete(oldest);
        }
      }
      if (!quiet) {
        this.reportOnce(
          warnings,
          parsed.problems.map((problem) => `Rules not loaded: ${problem}`),
          key,
        );
      }
      files.push(parsed);
    }
    return files;
  }

  private loadAddons(): Promise<{
    sources: Source[];
    infos: AddonInfo[];
    problems: string[];
  }> {
    this.addonLoad ??= (async () => {
      const discovered = this.deps.addons
        ? await this.deps.addons.discover().catch((error: unknown) => {
            return [
              {
                dirName: "(addons)",
                problems: [`could not list addons: ${describe(error)}`],
              },
            ];
          })
        : [];
      const validated = validateAddons(
        discovered,
        new Set(builtinSources.map((source) => source.id)),
        new Set(builtinAwaitingKinds.map((kind) => kind.id)),
      );
      this.known = new Set([
        ...builtinSources.map((source) => source.id),
        ...validated.sources.map((source) => source.id),
      ]);
      return validated;
    })();
    return this.addonLoad;
  }

  private async activeSources(
    config: GlobalConfig,
    warnings: string[],
    quiet = false,
  ): Promise<{ all: Source[]; enabled: Set<string> }> {
    const addons = await this.loadAddons();
    if (!quiet) this.reportOnce(warnings, addons.problems);
    const all = [...builtinSources, ...addons.sources];
    const enabled = new Set<string>();
    for (const source of all) {
      const entry = config.sources?.[source.id];
      if (entry?.enabled === false) continue;
      const problems = sourceSettingsProblems(
        source.id,
        source.settingsSchema,
        entry?.settings ?? {},
      );
      if (problems.length > 0) {
        if (!quiet) {
          this.reportOnce(
            warnings,
            problems.map(
              (problem) => `${problem} (source ${source.id} is off)`,
            ),
          );
        }
        continue;
      }
      enabled.add(source.id);
    }
    return { all, enabled };
  }

  private ensureSubscribed(
    source: Source,
    context: SourceContext,
    warnings: string[],
  ): void {
    if (!source.subscribe || this.subscriptions.has(source.id)) return;
    try {
      const unsubscribe = source.subscribe((event) => {
        this.pushed.push({ source: source.id, event });
        if (this.pushed.length > 1000) this.pushed.shift();
      }, context);
      this.subscriptions.set(
        source.id,
        typeof unsubscribe === "function" ? unsubscribe : () => {},
      );
    } catch (error) {
      this.subscriptions.set(source.id, () => {});
      this.reportOnce(warnings, [
        `Source ${source.id} subscribe failed: ${describe(error)}`,
      ]);
    }
  }

  /** Pushed events for `sourceId` as CloudEvents, deduplicated by source + id. */
  private drainPushed(
    sourceId: string,
    state: SourceState,
    time: string,
  ): CloudEvent[] {
    const mine = this.pushed.filter((entry) => entry.source === sourceId);
    if (mine.length === 0) return [];
    for (let index = this.pushed.length - 1; index >= 0; index -= 1) {
      if (this.pushed[index]?.source === sourceId) this.pushed.splice(index, 1);
    }
    const seen = new Set(state.seen ?? []);
    const events: CloudEvent[] = [];
    for (const { event } of mine) {
      if (typeof event?.type !== "string" || !event.type) continue;
      const id = event.id ?? this.eventIds.next();
      if (seen.has(id)) continue;
      seen.add(id);
      events.push({
        specversion: "1.0",
        id,
        source: sourceId,
        type: event.type,
        ...(event.subject ? { subject: event.subject } : {}),
        time: event.time ?? time,
        datacontenttype: "application/json",
        ...(event.data !== undefined ? { data: event.data } : {}),
      });
    }
    state.seen = [...seen].slice(-SEEN_WINDOW);
    return events;
  }

  private evaluationContext(
    files: readonly RuleFile[],
    tasksById: ReadonlyMap<string, Task>,
    states: ReadonlyMap<string, SourceState>,
    config: GlobalConfig,
    known: ReadonlySet<string>,
  ): EvaluationContext {
    const repoView = (repositoryId: string): RuleRepoView =>
      toRuleRepoView(
        repositoryId,
        config.repositories?.[repositoryId]?.deployment,
        known,
      );
    return {
      files,
      task: (taskId) => tasksById.get(taskId),
      variables: (event, task): RuleVariables => {
        const subject = task ? `task/${task.id}` : event.subject;
        const facts: RuleVariables["facts"] = {};
        for (const [sourceId, state] of states) {
          facts[sourceId] = subject
            ? (state.subjects[subject]?.facts ?? {})
            : {};
        }
        return {
          event,
          task: task ? toRuleTaskView(task) : null,
          facts,
          repo: task?.repositoryId ? repoView(task.repositoryId) : null,
        };
      },
      stages: (repositoryId) =>
        repositoryId
          ? repoView(repositoryId).deployment.stages.map((stage) => ({
              id: stage.id,
              label: stage.label,
              ...(stage.hook ? { hook: stage.hook } : {}),
              options: stage.options,
            }))
          : [],
      callJs: (reference, argument) => this.callJs(reference, argument),
    };
  }

  private async callJs(reference: string, argument: unknown): Promise<unknown> {
    const match = reference.match(/^js:(\.\/[^#]+)#([A-Za-z_$][\w$]*)$/);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Invalid JS reference: ${reference}`);
    }
    const module = await this.deps.rules.importModule(match[1]);
    const fn = module[match[2]];
    if (typeof fn !== "function") {
      throw new Error(`${match[1]} does not export a function ${match[2]}`);
    }
    return await (fn as (value: unknown) => unknown)(structuredClone(argument));
  }

  private async execute(
    action: PlannedRuleAction,
    tasksById: Map<string, Task>,
    input: RulesTickInput,
    warnings: string[],
  ): Promise<{
    outcome: AuditActionEntry["outcome"];
    detail?: string;
  }> {
    if (action.status !== "run") {
      return {
        outcome: action.status,
        ...(action.detail ? { detail: action.detail } : {}),
      };
    }
    const provenance: ActionProvenance = {
      ruleId: action.candidate.rule.id,
      eventId: action.candidate.event.id,
      source: action.candidate.event.source,
      ...(action.candidate.taskId ? { taskId: action.candidate.taskId } : {}),
    };
    try {
      switch (action.action) {
        case "move": {
          const task = action.candidate.taskId
            ? tasksById.get(action.candidate.taskId)
            : undefined;
          if (!task || !action.move) {
            return { outcome: "skipped", detail: "no task" };
          }
          const refusal = moveRefusal(task, action.move);
          if (refusal) return { outcome: "skipped", detail: refusal };
          return await input.executor.move(
            task,
            action.move,
            input.protectedPaths,
            warnings,
          );
        }
        case "inbox":
          return await input.executor.inbox(
            action.with as unknown as InboxActionInput,
            provenance,
          );
        case "createTask":
          return await input.executor.createTask(
            action.with as unknown as CreateTaskActionInput,
            provenance,
          );
        case "message":
          return await input.executor.message(
            action.with as unknown as MessageActionInput,
            provenance,
          );
        default:
          return {
            outcome: "skipped",
            detail: `unknown action ${action.action}`,
          };
      }
    } catch (error) {
      const task = action.candidate.taskId
        ? tasksById.get(action.candidate.taskId)
        : undefined;
      const detail = describe(error);
      warnings.push(
        `Rule ${action.candidate.rule.id}${task ? ` (${task.title})` : ""}: ${action.action} failed: ${detail}`,
      );
      return { outcome: "failed", detail };
    }
  }

  private auditWarnings(
    ruleWarnings: readonly RuleWarning[],
    time: string,
    audit: AuditEntry[],
    warnings: string[],
  ): void {
    for (const warning of ruleWarnings) {
      audit.push({
        kind: "warning",
        at: time,
        message: warning.message,
        ...(warning.taskId ? { taskId: warning.taskId } : {}),
        ...(warning.rule
          ? {
              ruleId: warning.rule.id,
              file: warning.rule.file,
              line: warning.rule.line,
            }
          : {}),
        ...(warning.eventId ? { eventId: warning.eventId } : {}),
      });
      this.reportOnce(warnings, [warning.message]);
    }
  }

  /** Push `problems` onto `warnings` the first time each is seen (per `scope`). */
  private reportOnce(
    warnings: string[],
    problems: readonly string[],
    scope = "",
  ): void {
    for (const problem of problems) {
      const key = `${scope}\u0000${problem}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      warnings.push(problem);
    }
  }
}

function isDue(source: Source, state: SourceState, now: Date): boolean {
  if (source.interval === undefined) return false;
  if (source.interval <= 0 || !state.polledAt) return true;
  return now.getTime() - Date.parse(state.polledAt) >= source.interval;
}

function pendingKey(ruleId: string, taskId: string): string {
  return `${ruleId}\u0000${taskId}`;
}

function actionEntry(
  action: PlannedRuleAction,
  result: { outcome: AuditActionEntry["outcome"]; detail?: string },
  time: string,
): AuditActionEntry {
  return {
    kind: "action",
    at: time,
    ...(action.candidate.taskId ? { taskId: action.candidate.taskId } : {}),
    ruleId: action.candidate.rule.id,
    file: action.candidate.rule.file,
    line: action.line,
    eventId: action.candidate.event.id,
    eventType: action.candidate.event.type,
    action:
      action.source === action.action
        ? action.action
        : `${action.source} → ${action.action}`,
    with: action.with,
    outcome: result.outcome,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

/** `YYYY-MM-DD` → that day's start (UTC); ISO passes through. */
function normalizeSince(since: string | undefined): string | undefined {
  if (!since) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00.000Z` : since;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}
