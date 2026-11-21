// A message awaiting approval in the inbox view's detail pane (see
// /docs/task-messaging.md decision 8 and docs/release-plan.md "Inbox"): the
// sender and route, the editable text, the delivery mode, attachments, and
// Approve / Reject. Nothing here pops up on its own or steals focus; the
// inbox's Priority badge is the whole signal.
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { MessageMode, TaskMessage } from "../../../preload/api";
import {
  approvalEdits,
  attachmentDataUrl,
  attachmentName,
  canApprove,
  isThumbnailable,
} from "../lib/approval-cards";
import { relativeTime } from "../lib/time-format";
import { useNow } from "../lib/use-now";
import { pushToast } from "../toast";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { Segmented } from "./ui/segmented";
import { Textarea } from "./ui/textarea";

/** An approval's edits as the inbox view holds them (so A / E / R work from the list). */
export interface ApprovalDraft {
  text: string;
  mode: MessageMode;
}

export function approvalDraftOf(message: TaskMessage): ApprovalDraft {
  return { text: message.text, mode: message.requestedMode };
}

export type ApprovalDecision = "approve" | "approve-both-ways" | "reject";

/** Whether the message can be approved with "allow both ways": only a task's message (never a plain session's or a rule's). */
export function canAllowBothWays(message: TaskMessage): boolean {
  return message.sender.kind === "task";
}

/**
 * Approve (with the user's edits, if any) or reject one message. Success:
 * the messaging push drops the item. Errors surface as a toast; resolves
 * whether it went through.
 */
export async function decideApproval(
  message: TaskMessage,
  kind: ApprovalDecision,
  draft: ApprovalDraft,
): Promise<boolean> {
  try {
    if (kind === "approve" || kind === "approve-both-ways") {
      if (!canApprove(draft.text)) return false;
      const edits = approvalEdits(message, draft);
      const result = await window.harbormaster.core.approveMessage(
        message.id,
        kind === "approve-both-ways"
          ? { ...edits, allowBothWays: true }
          : edits,
      );
      // Core re-checks the target on approval: if it can no longer receive,
      // the message is failed (and no grant is written). Say so.
      if (result.status !== "failed" && result.releasedCount) {
        pushToast(
          `Also released ${result.releasedCount} waiting message${result.releasedCount === 1 ? "" : "s"} between them.`,
        );
      }
      if (result.status === "failed") {
        pushToast(
          `Not delivered: ${result.failureReason ?? "the task can no longer receive it"}.${
            kind === "approve-both-ways"
              ? " Direct messages were not allowed."
              : ""
          }`,
        );
      }
    } else {
      await window.harbormaster.core.rejectMessage(message.id);
    }
    return true;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * The inbox detail pane for a message awaiting approval (see
 * /docs/task-messaging.md decision 8): sender → target, Approve / Reject at
 * the top, the full text (editable), the delivery mode, attachments.
 */
export function ApprovalDetail({
  message,
  targetTitle,
  draft,
  onDraftChange,
  editSignal,
}: {
  message: TaskMessage;
  targetTitle: string;
  draft: ApprovalDraft;
  onDraftChange: (draft: ApprovalDraft) => void;
  /** Bumped by the E key: focus the text to edit it. */
  editSignal: number;
}): JSX.Element {
  const now = useNow();
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (editSignal > 0) textRef.current?.focus();
  }, [editSignal]);

  async function decide(kind: ApprovalDecision): Promise<void> {
    setBusy(kind);
    // Success: the push drops this item; stay disabled until it unmounts.
    if (!(await decideApproval(message, kind, draft))) setBusy(null);
  }

  return (
    <article
      data-testid={`approval-card-${message.id}`}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          data-testid="approval-approve"
          disabled={busy !== null || !canApprove(draft.text)}
          onClick={() => void decide("approve")}
          title="Approve (A); E edits first"
        >
          Approve
          <Kbd>A</Kbd>
        </Button>
        {canAllowBothWays(message) && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="approval-approve-both-ways"
            disabled={busy !== null || !canApprove(draft.text)}
            onClick={() => void decide("approve-both-ways")}
            title="Approve this message, and let these two tasks message each other directly from now on"
          >
            Approve and allow both ways
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          data-testid="approval-reject"
          disabled={busy !== null}
          onClick={() => void decide("reject")}
          title="Reject (R)"
        >
          Reject
          <Kbd>R</Kbd>
        </Button>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground"
          title={message.createdAt}
          data-testid="approval-created"
        >
          {relativeTime(message.createdAt, now)}
        </span>
      </div>
      <div className="text-xs">
        <div className="text-muted-foreground">From</div>
        <div
          className="truncate font-semibold"
          data-testid="approval-route"
          title={`${message.senderLabel} → ${targetTitle}`}
        >
          {message.senderLabel} → {targetTitle}
        </div>
      </div>
      <Textarea
        ref={textRef}
        aria-label="Message text"
        data-testid="approval-text"
        value={draft.text}
        disabled={busy !== null}
        rows={8}
        onChange={(event) =>
          onDraftChange({ ...draft, text: event.target.value })
        }
        onKeyDown={(event) => {
          // E then edit, then Cmd/Ctrl+Enter approves the edited text.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void decide("approve");
          }
        }}
        title="Edit, then Cmd+Enter to approve"
      />
      <Segmented
        ariaLabel="Delivery mode"
        size="sm"
        className="self-start"
        testId="approval-mode"
        value={draft.mode}
        onValueChange={(mode) => onDraftChange({ ...draft, mode })}
        options={(["steer", "followUp"] as const).map((option) => ({
          value: option,
          label: option === "steer" ? "steer" : "follow up",
          testId: `approval-mode-${option}`,
          disabled: busy !== null,
          title:
            option === "steer"
              ? "Lands after the current turn's tool calls"
              : "Lands once the task has finished its pending work",
        }))}
      />
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
                className="rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                title={attachment.originalPath}
              >
                {attachmentName(attachment)}
              </span>
            ),
          )}
        </div>
      )}
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
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
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
      className="h-16 w-16 rounded-lg border border-border object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="h-16 w-16 rounded-lg border border-border bg-muted"
    />
  );
}
