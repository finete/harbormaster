// Approval inbox (see /docs/task-messaging.md decision 8): a header badge
// showing how many messages await the user's approval, and a side sheet of
// cards to approve (optionally edited) or reject them. Both views' headers
// host the button; App owns the single sheet. Nothing here pops up on its
// own, steals focus, or raises an OS notification: the badge is the whole
// signal, and the sheet only opens when the user clicks.
import { Inbox } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MessageMode, TaskMessage } from "../../../preload/api";
import { flattenBoard, useApprovals, useBoard } from "../core-client";
import {
  approvalEdits,
  attachmentDataUrl,
  attachmentName,
  canApprove,
  isThumbnailable,
} from "../lib/approval-cards";
import { relativeTime } from "../lib/time-format";
import { useNow } from "../lib/use-now";
import { cn } from "../lib/utils";
import { pushToast } from "../toast";
import { Button } from "./ui/button";
import { Sheet } from "./ui/sheet";
import { Textarea } from "./ui/textarea";

/**
 * Header control: an inbox icon with a count badge, hidden entirely while
 * nothing awaits approval. `compact` renders the icon-only variant for the
 * collapsed sidebar rail.
 */
export function ApprovalInboxButton({
  onClick,
  testId = "approval-inbox-button",
  compact = false,
}: {
  onClick: () => void;
  testId?: string;
  compact?: boolean;
}): JSX.Element | null {
  const count = useApprovals().length;
  if (count === 0) return null;
  const label = `${count} awaiting approval`;
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn("h-7 gap-1.5 px-2", compact && "gap-1 px-1.5")}
      data-testid={testId}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Inbox className="h-3.5 w-3.5" aria-hidden />
      {!compact && <span className="text-xs">awaiting approval</span>}
      <span
        data-testid={`${testId}-count`}
        className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground"
      >
        {count}
      </span>
    </Button>
  );
}

/** The inbox panel: one card per message awaiting approval, oldest first. */
export function ApprovalInboxSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element | null {
  const approvals = useApprovals();
  const columns = useBoard();
  const titles = useMemo(
    () => new Map(flattenBoard(columns).map((r) => [r.task.id, r.task.title])),
    [columns],
  );
  // The last pending message was just handled: close by itself. Opening an
  // already-empty inbox (the nav row is always there) shows the empty state.
  const previousCount = useRef(approvals.length);
  useEffect(() => {
    const had = previousCount.current;
    previousCount.current = approvals.length;
    if (open && had > 0 && approvals.length === 0) onOpenChange(false);
  }, [open, approvals.length, onOpenChange]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Messages awaiting approval"
      testId="approval-inbox"
    >
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Messages awaiting approval</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Another agent wants to message a task. Nothing is delivered until you
          approve.
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {approvals.length === 0 && (
          <p
            data-testid="approval-inbox-empty"
            className="py-8 text-center text-xs text-muted-foreground"
          >
            Nothing awaiting approval.
          </p>
        )}
        {approvals.map((message) => (
          <ApprovalCard
            key={message.id}
            message={message}
            targetTitle={titles.get(message.targetTaskId) ?? "Task"}
          />
        ))}
      </div>
    </Sheet>
  );
}

function ApprovalCard({
  message,
  targetTitle,
}: {
  message: TaskMessage;
  targetTitle: string;
}): JSX.Element {
  const now = useNow();
  const [text, setText] = useState(message.text);
  const [mode, setMode] = useState<MessageMode>(message.requestedMode);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  async function decide(kind: "approve" | "reject"): Promise<void> {
    setBusy(kind);
    try {
      if (kind === "approve") {
        const edits = approvalEdits(message, { text, mode });
        await window.harbormaster.core.approveMessage(message.id, edits);
      } else {
        await window.harbormaster.core.rejectMessage(message.id);
      }
      // Success: the push drops this card; stay disabled until it unmounts.
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error));
      setBusy(null);
    }
  }

  return (
    <article
      data-testid={`approval-card-${message.id}`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3"
    >
      <header className="flex min-w-0 items-baseline gap-2 text-xs">
        <span
          className="min-w-0 flex-1 truncate font-semibold"
          data-testid="approval-route"
          title={`${message.senderLabel} → ${targetTitle}`}
        >
          {message.senderLabel} → {targetTitle}
        </span>
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground"
          title={message.createdAt}
          data-testid="approval-created"
        >
          {relativeTime(message.createdAt, now)}
        </span>
      </header>
      <Textarea
        aria-label="Message text"
        data-testid="approval-text"
        value={text}
        disabled={busy !== null}
        rows={5}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex items-center gap-1" data-testid="approval-mode">
        {(["steer", "followUp"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            data-testid={`approval-mode-${option}`}
            disabled={busy !== null}
            title={
              option === "steer"
                ? "Lands after the current turn's tool calls"
                : "Lands once the task has finished its pending work"
            }
            onClick={() => setMode(option)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-50",
              mode === option
                ? "border-primary/60 bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent/50",
            )}
          >
            {option === "steer" ? "steer" : "follow up"}
          </button>
        ))}
      </div>
      {message.attachments.length > 0 && (
        <div
          className="flex flex-wrap gap-2"
          data-testid="approval-attachments"
        >
          {message.attachments.map((attachment, index) =>
            isThumbnailable(attachment) ? (
              <AttachmentThumbnail
                key={attachment.path}
                messageId={message.id}
                index={index}
                name={attachmentName(attachment)}
              />
            ) : (
              <span
                key={attachment.path}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                title={attachment.originalPath}
              >
                {attachmentName(attachment)}
              </span>
            ),
          )}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          data-testid="approval-reject"
          disabled={busy !== null}
          onClick={() => void decide("reject")}
        >
          Reject
        </Button>
        <Button
          size="sm"
          data-testid="approval-approve"
          disabled={busy !== null || !canApprove(text)}
          onClick={() => void decide("approve")}
        >
          Approve
        </Button>
      </div>
    </article>
  );
}

/** One image attachment, loaded lazily from core's stored copy; falls back to its file name when unreadable. */
function AttachmentThumbnail({
  messageId,
  index,
  name,
}: {
  messageId: string;
  index: number;
  name: string;
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.harbormaster.core
      .readMessageAttachment(messageId, index)
      .then((bytes) => {
        if (!cancelled) setSrc(attachmentDataUrl(bytes));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, index]);
  if (failed) {
    return (
      <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {name}
      </span>
    );
  }
  return src ? (
    <img
      src={src}
      alt={name}
      title={name}
      data-testid="approval-thumbnail"
      className="h-16 w-16 rounded border border-border object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="h-16 w-16 rounded border border-border bg-muted"
    />
  );
}
