// Pure display helpers for a task's agent (harness + model), e.g. the
// sidebar row's "pi · claude-opus-4-8 · your move". See
// /docs/new-task-composer.md "Task rows".
import type { Task } from "../../../preload/api";

/** `provider/name` -> `name`. */
export function shortModelName(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

/**
 * The model a task runs (or will run) with: its own choice, the legacy
 * launch-time choice, else what its first session actually started with
 * (`sessionModel`); `undefined` when none is known yet (a parked task on
 * the default, or one created before tasks recorded models).
 */
export function taskModel(
  task: Pick<Task, "model" | "launch" | "sessionModel">,
): string | undefined {
  return task.model ?? task.launch?.model ?? task.sessionModel;
}

/** `"pi · claude-opus-4-8"`, or just `"pi"` when no model is known. */
export function taskAgentLabel(
  task: Pick<Task, "harness" | "model" | "launch" | "sessionModel">,
): string {
  const model = taskModel(task);
  const harness = task.harness ?? "pi";
  return model ? `${harness} · ${shortModelName(model)}` : harness;
}
