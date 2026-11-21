import { Archive, Loader2, Play, RotateCcw } from "lucide-react";
import type { JSX, MouseEvent } from "react";
import { useState } from "react";
import type { Task } from "../../../preload/api";
import {
  archiveTaskMutation,
  canArchive,
  canAwait,
  canDone,
  canReopen,
  reopenTaskMutation,
  startTaskMutation,
  toAwaitMutation,
  toDoneMutation,
} from "../lib/task-mutations";
import { type AwaitChoice, AwaitDialog } from "./AwaitDialog";
import { ReopenTaskDialog } from "./ReopenTaskDialog";
import { ReviewButton } from "./ReviewButton";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

/**
 * The focused task's workflow verbs in `TaskWorkspace`'s header — the only
 * place workflow buttons live (a board card's only button is its hover ×
 * Archive; the board drives the same verbs by key and drag): Start
 * (backlog) · Review ▾ (Working/Awaiting, see ReviewButton) · Await… ·
 * Done, or Reopen once Done; Archive (takes it off the board, completing it first if
 * needed) on every task not archived yet. Await… opens the shared kind
 * picker (`AwaitDialog`); which awaiting kinds exist and what each does is core's registry, never a
 * button here. Everything calls straight through the IPC bridge — the
 * board re-renders from the next `board-changed` push, never from a
 * locally-applied result. Thrown errors and returned warnings surface as a
 * toast (see `toast.ts`).
 */
export function TaskActions({ task }: { task: Task }): JSX.Element {
  const [busy, setBusy] = useState<
    "start" | "await" | "done" | "reopen" | "archive" | null
  >(null);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [awaitOpen, setAwaitOpen] = useState(false);

  const awaitAllowed = canAwait(task);
  const doneAllowed = canDone(task);
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

  async function handleArchive(
    event: MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    stopClick(event);
    if (busy) return;
    setBusy("archive");
    try {
      await archiveTaskMutation(task.id);
    } finally {
      setBusy(null);
    }
  }

  const archiveButton = canArchive(task) && (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy !== null}
      onClick={handleArchive}
      data-testid={`archive-task-button-${task.id}`}
      title={
        task.state === "done"
          ? "Archive: take it off the board (the sidebar's Archived section lists it) (e)"
          : "Archive: mark it done and take it off the board (e)"
      }
    >
      {busy === "archive" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Archive className="h-3.5 w-3.5" />
      )}
      Archive
      <Kbd>e</Kbd>
    </Button>
  );

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
          variant="secondary"
          disabled={busy !== null}
          onClick={handleReopenClick}
          data-testid={`reopen-task-button-${task.id}`}
          title="Reopen: back to Working with a fresh branch + worktree, continuing the previous conversation"
        >
          {busy === "reopen" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          Reopen
        </Button>
        {archiveButton}
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
          title="Start: create the branch + worktree and move to Working (s)"
        >
          {busy === "start" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Start
          <Kbd>s</Kbd>
        </Button>
      )}
      {(task.state === "working" || task.state === "awaiting") && (
        <ReviewButton task={task} />
      )}
      <Button
        size="sm"
        variant="secondary"
        disabled={!awaitAllowed || busy !== null}
        onClick={handleAwaitClick}
        data-testid={`await-button-${task.id}`}
        title="Move to Awaiting: pick why (r on the board)"
      >
        {busy === "await" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Await…
        <Kbd>r</Kbd>
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!doneAllowed || busy !== null}
        onClick={handleToDone}
        data-testid={`to-done-button-${task.id}`}
        title="Move to Done (x)"
      >
        {busy === "done" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Done
        <Kbd>x</Kbd>
      </Button>
      {archiveButton}
      <AwaitDialog
        taskId={awaitOpen ? task.id : null}
        reviewer={task.pr?.role === "reviewer"}
        onCancel={() => setAwaitOpen(false)}
        onConfirm={(choice) => void handleAwaitConfirm(choice)}
      />
    </div>
  );
}
