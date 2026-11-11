// Engine: rule matching, condition evaluation, action rendering and
// per-tick arbitration. Owns no I/O: the JS escape hatch and the current
// tasks/facts are injected, and the result is a plan the manager executes
// (or `rulesCheck` reports). Arbitration: one `move` per task per tick,
// the first matching rule in list order wins (illegal or no-op moves are
// skipped so the next rule gets its turn, like the old mover arbiter);
// every matching `inbox` / `createTask` / `message` runs. A thrown
// condition or action is a no-op plus a warning.

import type {
  AwaitingKind,
  AwaitingKindId,
  DeploymentStageConfig,
  Task,
  TaskState,
} from "../../contracts/model.js";
import type {
  CloudEvent,
  MoveActionInput,
  Rule,
  RuleActionSpec,
  RuleFile,
  RuleVariables,
} from "../../contracts/rules.js";
import {
  findAwaitingKind,
  normalizeAwaitingInputs,
} from "../awaiting-kinds.js";
import { PRODUCTION_STAGE } from "../deployment.js";
import {
  assertMayReturnToDev,
  isAllowedTransition,
} from "../task-transitions.js";
import { evaluateCondition, renderTemplate } from "./cel.js";
import { activeRules, matchesEventType } from "./rule-files.js";
import { taskIdOfSubject } from "./snapshot-diff.js";

/** A rule whose `on` matched an event (and, once evaluated, whose `if` held). */
export interface RuleCandidate {
  rule: Rule;
  /** Index in the task's active rule list (arbitration order). */
  order: number;
  event: CloudEvent;
  taskId?: string;
  variables: RuleVariables;
  /** Re-evaluated from the pending-move queue rather than a fresh event. */
  retry?: boolean;
}

/** A resolved `move` target. */
export interface ResolvedMove {
  state: TaskState;
  awaiting?: AwaitingKind;
  /** For `await`: the kind and its inputs, and whether to run its onEnter. */
  kind?: AwaitingKindId;
  inputs?: Record<string, string>;
  enter: boolean;
}

export interface PlannedRuleAction {
  candidate: RuleCandidate;
  /** `move` / `inbox` / `createTask` / `message`. */
  action: string;
  /** The `do` entry as written (`js:…` for a JS action's output). */
  source: string;
  line: number;
  with: Record<string, unknown>;
  move?: ResolvedMove;
  /** `run` = execute; the rest are already decided no-ops. */
  status: "run" | "superseded" | "skipped" | "failed";
  detail?: string;
}

export interface RuleWarning {
  message: string;
  rule?: Rule;
  eventId?: string;
  taskId?: string;
}

/** Injected I/O and lookups. */
export interface EvaluationContext {
  files: readonly RuleFile[];
  task(taskId: string): Task | undefined;
  variables(event: CloudEvent, task: Task | undefined): RuleVariables;
  /** Deployment stages (effective) of a repository. */
  stages(repositoryId: string | undefined): readonly DeploymentStageConfig[];
  /** Call a `js:./file.mjs#fn` reference with one argument. */
  callJs(reference: string, argument: unknown): Promise<unknown>;
}

const BUILTIN_ACTIONS = new Set(["move", "inbox", "createTask", "message"]);

/**
 * Every (rule, event) pair whose `on` matches and whose condition holds,
 * at most one per (rule, task) — so two events about one task in a tick
 * never run a rule's actions twice. `pending` (re-evaluated moves) is
 * matched by rule id against the task's current rule list.
 */
export async function matchRules(
  events: readonly CloudEvent[],
  pending: ReadonlyArray<{ ruleId: string; event: CloudEvent }>,
  context: EvaluationContext,
): Promise<{ candidates: RuleCandidate[]; warnings: RuleWarning[] }> {
  const candidates: RuleCandidate[] = [];
  const warnings: RuleWarning[] = [];
  const seen = new Set<string>();

  const consider = async (
    rule: Rule,
    order: number,
    event: CloudEvent,
    task: Task | undefined,
    retry: boolean,
  ) => {
    const key = `${rule.file}#${rule.id}#${task?.id ?? `event:${event.id}`}`;
    if (seen.has(key)) return;
    const variables = context.variables(event, task);
    try {
      if (!(await conditionHolds(rule, variables, context))) return;
    } catch (error) {
      warnings.push({
        message: `Rule ${rule.id} (${rule.file}:${rule.line}): condition failed: ${describe(error)}`,
        rule,
        eventId: event.id,
        ...(task ? { taskId: task.id } : {}),
      });
      return;
    }
    seen.add(key);
    candidates.push({
      rule,
      order,
      event,
      ...(task ? { taskId: task.id } : {}),
      variables,
      ...(retry ? { retry: true } : {}),
    });
  };

  for (const event of events) {
    const taskId = taskIdOfSubject(event.subject);
    const task = taskId ? context.task(taskId) : undefined;
    // An event about a task that no longer exists is not evaluated.
    if (taskId && !task) continue;
    const rules = activeRules(context.files, task?.repositoryId);
    for (const [order, rule] of rules.entries()) {
      if (!rule.on.some((pattern) => matchesEventType(pattern, event.type))) {
        continue;
      }
      await consider(rule, order, event, task, false);
    }
  }
  for (const entry of pending) {
    const taskId = taskIdOfSubject(entry.event.subject);
    const task = taskId ? context.task(taskId) : undefined;
    if (!task) continue;
    const rules = activeRules(context.files, task.repositoryId);
    const order = rules.findIndex((rule) => rule.id === entry.ruleId);
    const rule = rules[order];
    if (!rule) continue;
    await consider(rule, order, entry.event, task, true);
  }
  return { candidates, warnings };
}

async function conditionHolds(
  rule: Rule,
  variables: RuleVariables,
  context: EvaluationContext,
): Promise<boolean> {
  if (rule.if === undefined) return true;
  if (rule.if.startsWith("js:")) {
    const result = await context.callJs(rule.if, variables);
    if (typeof result !== "boolean") {
      throw new Error(`${rule.if} must return a boolean`);
    }
    return result;
  }
  return evaluateCondition(rule.if, variables);
}

/**
 * Render every candidate's actions and arbitrate moves: candidates run in
 * rule-list order; per task the first legal, non-no-op move wins and later
 * ones are `superseded`.
 */
export async function planActions(
  candidates: readonly RuleCandidate[],
  context: EvaluationContext,
): Promise<{ actions: PlannedRuleAction[]; warnings: RuleWarning[] }> {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.order - b.candidate.order || a.index - b.index)
    .map((entry) => entry.candidate);
  const actions: PlannedRuleAction[] = [];
  const warnings: RuleWarning[] = [];
  const movedBy = new Map<string, string>();

  for (const candidate of ordered) {
    const specs = await expandActions(candidate, context, actions);
    for (const { spec, source } of specs) {
      const line = spec.line ?? candidate.rule.line;
      const base = {
        candidate,
        action: spec.action,
        source,
        line,
      };
      let rendered: Record<string, unknown>;
      try {
        rendered = (renderTemplate(spec.with ?? {}, candidate.variables) ??
          {}) as Record<string, unknown>;
      } catch (error) {
        actions.push({
          ...base,
          with: spec.with ?? {},
          status: "failed",
          detail: `template failed: ${describe(error)}`,
        });
        continue;
      }
      if (spec.action !== "move") {
        actions.push({ ...base, with: rendered, status: "run" });
        continue;
      }
      const task = candidate.taskId
        ? context.task(candidate.taskId)
        : undefined;
      if (!task) {
        actions.push({
          ...base,
          with: rendered,
          status: "skipped",
          detail: "move needs a task-bound event",
        });
        continue;
      }
      let move: ResolvedMove;
      try {
        move = resolveMove(
          task,
          rendered as unknown as MoveActionInput,
          context.stages(task.repositoryId),
        );
      } catch (error) {
        actions.push({
          ...base,
          with: rendered,
          status: "failed",
          detail: describe(error),
        });
        continue;
      }
      const winner = movedBy.get(task.id);
      if (winner) {
        actions.push({
          ...base,
          with: rendered,
          move,
          status: "superseded",
          detail: `rule ${winner} moves this task this tick`,
        });
        continue;
      }
      const refusal = moveRefusal(task, move);
      if (refusal) {
        actions.push({
          ...base,
          with: rendered,
          move,
          status: "skipped",
          detail: refusal,
        });
        continue;
      }
      movedBy.set(task.id, candidate.rule.id);
      actions.push({ ...base, with: rendered, move, status: "run" });
    }
  }
  return { actions, warnings };
}

/** A candidate's `do` list with JS actions expanded into the built-in actions they return. */
async function expandActions(
  candidate: RuleCandidate,
  context: EvaluationContext,
  failures: PlannedRuleAction[],
): Promise<Array<{ spec: RuleActionSpec; source: string }>> {
  const expanded: Array<{ spec: RuleActionSpec; source: string }> = [];
  for (const spec of candidate.rule.do) {
    if (!spec.action.startsWith("js:")) {
      expanded.push({ spec, source: spec.action });
      continue;
    }
    try {
      const rendered = (renderTemplate(spec.with ?? {}, candidate.variables) ??
        {}) as Record<string, unknown>;
      const result = await context.callJs(spec.action, {
        ...candidate.variables,
        with: rendered,
      });
      for (const produced of toActionSpecs(result)) {
        expanded.push({
          spec: { ...produced, ...(spec.line ? { line: spec.line } : {}) },
          source: spec.action,
        });
      }
    } catch (error) {
      failures.push({
        candidate,
        action: spec.action,
        source: spec.action,
        line: spec.line ?? candidate.rule.line,
        with: spec.with ?? {},
        status: "failed",
        detail: describe(error),
      });
    }
  }
  return expanded;
}

/** A JS action returns nothing, one built-in action spec, or a list of them. */
function toActionSpecs(result: unknown): RuleActionSpec[] {
  if (result === undefined || result === null) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { action?: unknown }).action !== "string" ||
      !BUILTIN_ACTIONS.has((entry as { action: string }).action)
    ) {
      throw new Error(
        "a JS action must return { action: move|inbox|createTask|message, with } (or a list of them)",
      );
    }
    const { action, with: input } = entry as {
      action: string;
      with?: Record<string, unknown>;
    };
    return { action, ...(input ? { with: input } : {}) };
  });
}

/** Resolve a `move` input against the task (pure; throws on bad input). */
export function resolveMove(
  task: Task,
  input: MoveActionInput,
  stages: readonly DeploymentStageConfig[],
): ResolvedMove {
  const enter = input.enter === true;
  switch (input.to) {
    case "dev":
      return { state: "dev", enter };
    case "done":
      return { state: "done", enter };
    case "await": {
      const kindId = (input.kind ?? "review") as AwaitingKindId;
      const kind = findAwaitingKind(kindId);
      if (!kind) throw new Error(`Unknown awaiting kind: ${kindId}`);
      const rawInputs = Object.fromEntries(
        Object.entries(input.input ?? {}).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
      const inputs = normalizeAwaitingInputs(kind, rawInputs);
      let awaiting = kind.awaitingFor(task, inputs, { stages });
      if (kindId === "deploy" && rawInputs.stage) {
        const stage =
          rawInputs.stage === PRODUCTION_STAGE.id
            ? PRODUCTION_STAGE
            : stages.find((candidate) => candidate.id === rawInputs.stage);
        if (!stage) {
          throw new Error(`Unknown deployment stage: ${rawInputs.stage}`);
        }
        awaiting = {
          kind: "deploy",
          stageId: stage.id,
          stageLabel: stage.label,
        };
      }
      return { state: "awaiting", awaiting, kind: kindId, inputs, enter };
    }
    default:
      throw new Error(
        `move.to must be dev, done or await (got ${JSON.stringify((input as { to?: unknown }).to)})`,
      );
  }
}

/** Why a resolved move cannot (or need not) apply to the task as it is now. */
export function moveRefusal(
  task: Task,
  move: ResolvedMove,
): string | undefined {
  if (!isAllowedTransition(task.state, move.state)) {
    return `illegal move from ${task.state} to ${move.state}`;
  }
  try {
    assertMayReturnToDev(task.state, task.awaiting, move.state);
  } catch (error) {
    return describe(error);
  }
  if (
    task.state === move.state &&
    (move.state !== "awaiting" ||
      JSON.stringify(task.awaiting) === JSON.stringify(move.awaiting))
  ) {
    return `already ${describeState(move)}`;
  }
  return undefined;
}

function describeState(move: ResolvedMove): string {
  if (move.state !== "awaiting" || !move.awaiting) return `in ${move.state}`;
  const awaiting = move.awaiting as { kind: string; stageId?: string };
  return `awaiting ${awaiting.kind}${awaiting.stageId ? ` (${awaiting.stageId})` : ""}`;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}
