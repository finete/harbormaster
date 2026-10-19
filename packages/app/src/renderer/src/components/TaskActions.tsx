import { Loader2, Play, Rocket, RotateCcw } from "lucide-react";
import type { JSX, MouseEvent } from "react";
import { useState } from "react";
import type { Task } from "../../../preload/api";
import {
  canAwait,
  canDone,
  canReopen,
  reopenTaskMutation,
  startTaskMutation,
  toAwaitMutation,
  toDoneMutation,
} from "../lib/task-mutations";
import { type AwaitChoice, AwaitDialog } from "./AwaitDialog";
import { type LaunchRelation, LaunchTaskDialog } from "./LaunchTaskDialog";
import { ReopenTaskDialog } from "./ReopenTaskDialog";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

/**
 * The focused task's workflow verbs in `TaskWorkspace`'s header — the only
 * place action buttons live (board cards carry none; the board drives the
 * same verbs by key and drag): Start (backlog) · Await… · Done, or Reopen
 * once Done. Await… opens the shared kind picker (`AwaitDialog`); which
 * awaiting kinds exist and what each does is core's registry, never a
 * button here. Everything calls straight through the IPC bridge — the
 * board re-renders from the next `board-changed` push, never from a
 * locally-applied result. Thrown errors and returned warnings surface as a
 * toast (see `toast.ts`).
 */
export function TaskActions({ task }: { task: Task }): JSX.Element {
  const [busy, setBusy] = useState<
    "start" | "await" | "done" | "reopen" | null
  >(null);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [awaitOpen, setAwaitOpen] = useState(false);
  // Launch dialog (see LaunchTaskDialog.tsx): one dialog instance, relation
  // preselected by which button opened it but switchable inside.
  const [launchRelation, setLaunchRelation] = useState<LaunchRelation | null>(
    null,
  );

  const awaitAllowed = canAwait(task);
  const doneAllowed = canDone(task);
  // One level only (see ai/prds/task-launching.md): a task that is itself a
  // child can never launch further children, only standalone tasks.
  const canLaunchSubtask = !task.parentTaskId;

  function launchButtons(): JSX.Element {
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          disabled={!canLaunchSubtask}
          onClick={(event) => {
            stopClick(event);
            setLaunchRelation("child");
          }}
          data-testid={`launch-subtask-button-${task.id}`}
          title={
            canLaunchSubtask
              ? "Launch a child task: nested under this one, pollable"
              : "A child task cannot launch further children (one level only)"
          }
        >
          <Rocket className="h-3 w-3" />
          Launch subtask…
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={(event) => {
            stopClick(event);
            setLaunchRelation("standalone");
          }}
          data-testid={`launch-task-button-${task.id}`}
          title="Launch a standalone task: no lineage, no polling"
        >
          <Rocket className="h-3 w-3" />
          Launch task…
        </Button>
        <LaunchTaskDialog
          open={launchRelation !== null}
          onOpenChange={(open) => {
            if (!open) setLaunchRelation(null);
          }}
          fromTask={task}
          defaultRelation={launchRelation ?? "standalone"}
        />
      </>
    );
  }

  function stopClick(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
  }

  async function handleStart(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    stopClick(event);
    if (busy) return;
    setBusy("start");
    try {
      await startTaskMutation(task.id);
    } finally {
      setBusy(null);
    }
  }

  function handleAwaitClick(event: MouseEvent<HTMLButtonElement>): void {
    stopClick(event);
    if (busy) return;
    setAwaitOpen(true);
  }

  async function handleAwaitConfirm(choice: AwaitChoice): Promise<void> {
    setAwaitOpen(false);
    if (busy) return;
    setBusy("await");
    try {
      await toAwaitMutation(task.id, choice.kindId, choice.options);
    } finally {
      setBusy(null);
    }
  }

  async function handleToDone(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    stopClick(event);
    if (busy) return;
    setBusy("done");
    try {
      await toDoneMutation(task.id);
    } finally {
      setBusy(null);
    }
  }

  function handleReopenClick(event: MouseEvent<HTMLButtonElement>): void {
    stopClick(event);
    if (busy) return;
    setReopenOpen(true);
  }

  async function handleReopenConfirm(objective: string): Promise<void> {
    setReopenOpen(false);
    if (busy) return;
    setBusy("reopen");
    try {
      await reopenTaskMutation(task.id, objective);
    } finally {
      setBusy(null);
    }
  }

  if (canReopen(task)) {
    return (
      <div
        className="flex items-center gap-1.5"
        data-testid={`task-actions-${task.id}`}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={handleReopenClick}
          data-testid={`reopen-task-button-${task.id}`}
          title="Reopen: a new Dev cycle (fresh branch + worktree) that continues the previous conversation"
        >
          {busy === "reopen" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          Reopen
        </Button>
        {launchButtons()}
        {/* Clicks inside the dialog must not bubble to the header's hosts. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: event-propagation boundary only, not an interactive element. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: same — keyboard events are handled by the dialog itself. */}
        <div onClick={(event) => event.stopPropagation()}>
          <ReopenTaskDialog
            open={reopenOpen}
            title={task.title}
            onCancel={() => setReopenOpen(false)}
            onConfirm={(objective) => void handleReopenConfirm(objective)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5"
      data-testid={`task-actions-${task.id}`}
    >
      {task.state === "backlog" && (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={handleStart}
          data-testid={`start-task-button-${task.id}`}
          title="Start: create the branch + worktree and move to Dev (s)"
        >
          {busy === "start" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          Start
          <Kbd>s</Kbd>
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!awaitAllowed || busy !== null}
        onClick={handleAwaitClick}
        data-testid={`await-button-${task.id}`}
        title="Move to Awaiting: pick why (r on the board)"
      >
        {busy === "await" && <Loader2 className="h-3 w-3 animate-spin" />}
        Await…
        <Kbd>r</Kbd>
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!doneAllowed || busy !== null}
        onClick={handleToDone}
        data-testid={`to-done-button-${task.id}`}
        title="Move to Done (x)"
      >
        {busy === "done" && <Loader2 className="h-3 w-3 animate-spin" />}
        Done
        <Kbd>x</Kbd>
      </Button>
      {launchButtons()}
      <AwaitDialog
        taskId={awaitOpen ? task.id : null}
        onCancel={() => setAwaitOpen(false)}
        onConfirm={(choice) => void handleAwaitConfirm(choice)}
      />
    </div>
  );
}
