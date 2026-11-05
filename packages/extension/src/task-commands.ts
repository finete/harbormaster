// Pure command logic behind the in-session command surface
// (/todev, /toawait, /todone) plus the `harbormaster_report_status` tool.
// Everything here is plain functions over narrow interfaces (`TaskCommandsCore`,
// `TaskCommandsUi`) so it is testable with a fake core/ctx — `index.ts` is the
// only place that wires these against a real `pi` extension API and
// `ctx.ui`. Three invariant verbs, no kind-named commands (decision #16 in
// /docs/design-decisions.md): awaiting *kinds* are data the one `toawait`
// verb is parameterized with.

import type {
  AwaitingKindField,
  AwaitingKindId,
  AwaitingKindOption,
  CoreCommands,
  ToDoneConfirmation,
  ToDoneOptions,
} from "@harbormaster/core";
import { isToDoneConfirmation } from "@harbormaster/core";

/** The user's answers to a previous `toDone` confirmation question (ported from the app's local `ToDoneForce`, since core keeps it inline on `ToDoneOptions`). */
export type ToDoneForce = NonNullable<ToDoneOptions["force"]>;

/** The slice of `ctx.ui` these commands need — matches `ExtensionUIContext`'s dialog/notify shape. */
export interface TaskCommandsUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** The slice of `Core` these commands call. */
export interface TaskCommandsCore {
  commands: Pick<
    CoreCommands,
    "moveTask" | "listAwaitingKinds" | "toAwait" | "toDone"
  >;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One awaiting-kind option as the `/toawait` select presents it: the kind's
 * notice (e.g. the deploy squash-merge warning) folded into the label text
 * so the select dialog itself carries the side-effect wording the app's
 * picker shows separately. Unavailable kinds are omitted — `toAwait` would
 * reject them anyway, and a disabled-but-visible option has no pi dialog
 * affordance.
 */
export interface AwaitingKindChoice {
  id: AwaitingKindId;
  display: string;
}

export function buildAwaitingKindChoices(
  options: readonly AwaitingKindOption[],
): AwaitingKindChoice[] {
  return options
    .filter((option) => option.available)
    .map((option) => ({
      id: option.id,
      display: option.notice
        ? `${option.label} — ${option.notice}`
        : option.label,
    }));
}

export type AwaitInputsResult =
  | { ok: true; inputs: Record<string, string> }
  | { ok: false; missingField: AwaitingKindField };

/**
 * Trim each field's answer, dropping blank optional ones; a blank required
 * field aborts (no kind here declares one today, but the registry is
 * data-driven — see `engines/awaiting-kinds.ts` — so new kinds may add one).
 */
export function buildAwaitInputs(
  fields: readonly AwaitingKindField[],
  answers: Readonly<Record<string, string | undefined>>,
): AwaitInputsResult {
  const inputs: Record<string, string> = {};
  for (const field of fields) {
    const raw = answers[field.id]?.trim();
    if (!raw) {
      if (!field.optional) return { ok: false, missingField: field };
      continue;
    }
    inputs[field.id] = raw;
  }
  return { ok: true, inputs };
}

/** `/todev`: move to Dev, surfacing a transition error via `ctx.ui.notify`. */
export async function runToDevCommand(
  core: TaskCommandsCore,
  taskId: string,
  ui: TaskCommandsUi,
): Promise<boolean> {
  try {
    await core.commands.moveTask(taskId, "dev");
    ui.notify("Moved to Dev", "info");
    return true;
  } catch (error) {
    ui.notify(describeError(error), "error");
    return false;
  }
}

/**
 * `/toawait`: pick a kind (`listAwaitingKinds`, applicability respected),
 * collect its input fields, then `toAwait`. Cancelling any dialog (select or
 * a required input) leaves the task untouched.
 */
export async function runToAwaitCommand(
  core: TaskCommandsCore,
  taskId: string,
  ui: TaskCommandsUi,
): Promise<boolean> {
  try {
    const options = await core.commands.listAwaitingKinds(taskId);
    const choices = buildAwaitingKindChoices(options);
    if (!choices.length) {
      ui.notify("No awaiting kind applies to this task right now", "warning");
      return false;
    }
    const selectedDisplay = await ui.select(
      "Await what?",
      choices.map((choice) => choice.display),
    );
    if (!selectedDisplay) return false;
    const choice = choices.find((c) => c.display === selectedDisplay);
    if (!choice) return false;
    const kindOption = options.find((option) => option.id === choice.id);
    if (!kindOption) return false;

    const answers: Record<string, string | undefined> = {};
    for (const field of kindOption.fields) {
      answers[field.id] = await ui.input(field.label, field.placeholder);
    }
    const resolved = buildAwaitInputs(kindOption.fields, answers);
    if (!resolved.ok) {
      ui.notify(`${resolved.missingField.label} is required`, "warning");
      return false;
    }

    await core.commands.toAwait(taskId, choice.id, { inputs: resolved.inputs });
    ui.notify(`Awaiting ${kindOption.label}`, "info");
    return true;
  } catch (error) {
    ui.notify(describeError(error), "error");
    return false;
  }
}

/**
 * pi-home's completion questions, reused verbatim from the app's
 * `task-mutations.ts` `DONE_QUESTIONS`/`DONE_MESSAGES` so the in-session
 * confirm dialog matches the app's wording exactly.
 */
export const DONE_QUESTIONS: Record<
  ToDoneConfirmation["requiresConfirmation"],
  { title: string; flag: keyof ToDoneForce }
> = {
  dirty: { title: "Discard uncommitted changes?", flag: "removeDirty" },
  unmerged: {
    title: "Delete unmerged task workspace?",
    flag: "deleteUnmerged",
  },
  activeChildren: {
    title: "Complete with active children?",
    flag: "leaveChildren",
  },
};

export const DONE_MESSAGES: Record<
  ToDoneConfirmation["requiresConfirmation"],
  string
> = {
  dirty: "The worktree has uncommitted changes — remove it anyway?",
  unmerged:
    "The branch isn't merged — delete the worktree and local branch anyway?",
  activeChildren:
    "This task has active child tasks — complete it anyway? They keep running, nested under it.",
};

/**
 * `/todone`: `toDone`, confirming destructive cleanup through `ctx.ui.confirm`
 * with the app's exact wording when it returns `requiresConfirmation`, then
 * retrying with the accumulated `force` flags. Warnings surface via
 * `ctx.ui.notify`; the same question twice means core refused despite the
 * answer, so the loop never repeats a question.
 *
 * `protectedPaths` must include this session's own worktree (its cwd): the
 * command runs *inside* the task's live Pi session, so without it `toDone`
 * would remove the worktree out from under the running session (the app's
 * Done path passes live pane cwds for exactly this reason). The worktree is
 * then left in place with a warning and the refresh sweep reaps it once the
 * pane closes.
 */
export async function runToDoneCommand(
  core: TaskCommandsCore,
  taskId: string,
  ui: TaskCommandsUi,
  options: { protectedPaths?: readonly string[] } = {},
): Promise<boolean> {
  const protectedPaths = options.protectedPaths
    ? [...options.protectedPaths]
    : undefined;
  try {
    const force: ToDoneForce = {};
    for (;;) {
      const result = await core.commands.toDone(taskId, {
        force,
        ...(protectedPaths ? { protectedPaths } : {}),
      });
      if (!isToDoneConfirmation(result)) {
        ui.notify(
          result.warning ?? "Moved to Done",
          result.warning ? "warning" : "info",
        );
        return true;
      }
      const question = DONE_QUESTIONS[result.requiresConfirmation];
      if (force[question.flag]) {
        ui.notify(result.detail, "error");
        return false;
      }
      const confirmed = await ui.confirm(
        question.title,
        `${DONE_MESSAGES[result.requiresConfirmation]} (${result.detail})`,
      );
      if (!confirmed) return false;
      force[question.flag] = true;
    }
  } catch (error) {
    ui.notify(describeError(error), "error");
    return false;
  }
}
