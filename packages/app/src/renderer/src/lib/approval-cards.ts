// Pure rules behind the approval inbox's cards (see
// components/ApprovalInbox.tsx and /docs/task-messaging.md decision 8),
// free of React so they are unit-testable without a DOM
// (tests/approval-cards.test.ts).
import type { MessageAttachment, MessageMode } from "../../../preload/api";

/** What the user changed on a card; `undefined` when nothing differs (Approve then sends no edits at all). */
export function approvalEdits(
  original: { text: string; requestedMode: MessageMode },
  draft: { text: string; mode: MessageMode },
): { text?: string; mode?: MessageMode } | undefined {
  const edits: { text?: string; mode?: MessageMode } = {};
  if (draft.text !== original.text) edits.text = draft.text;
  if (draft.mode !== original.requestedMode) edits.mode = draft.mode;
  return Object.keys(edits).length > 0 ? edits : undefined;
}

/** A message with no text left can't be approved (core would reject it); the Approve button stays disabled. */
export function canApprove(draftText: string): boolean {
  return draftText.trim().length > 0;
}

/** Whether a stored attachment copy can be shown as a thumbnail: an image whose file still exists. */
export function isThumbnailable(attachment: MessageAttachment): boolean {
  return (
    attachment.prunedAt === undefined &&
    (attachment.mimeType?.startsWith("image/") ?? false)
  );
}

/** The attachment's display name: the file name of the path the sender gave. */
export function attachmentName(attachment: MessageAttachment): string {
  const parts = attachment.originalPath.split(/[\\/]/);
  return parts[parts.length - 1] || attachment.originalPath;
}

/** `data:` URL for an attachment's bytes as returned by `readMessageAttachment`. */
export function attachmentDataUrl(bytes: {
  mimeType?: string;
  base64: string;
}): string {
  return `data:${bytes.mimeType ?? "application/octet-stream"};base64,${bytes.base64}`;
}
