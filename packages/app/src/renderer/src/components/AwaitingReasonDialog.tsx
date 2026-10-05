import type { JSX } from "react";
import { useState } from "react";
import type { AwaitingKind } from "../../../preload/api";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type ReasonKind = AwaitingKind["kind"];

const REASON_OPTIONS: { value: ReasonKind; label: string }[] = [
  { value: "review", label: "Review" },
  { value: "slack", label: "Slack response" },
  { value: "deploy", label: "Deployment stage" },
];

/**
 * Dropping a card into the "awaiting" column requires a reason — this
 * confirms it (or aborts the move; the card stays where it was). Moving
 * *out* of awaiting needs no dialog (see Board.tsx).
 */
export function AwaitingReasonDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: (awaiting: AwaitingKind) => void;
}): JSX.Element {
  const [kind, setKind] = useState<ReasonKind>("review");
  const [stageId, setStageId] = useState("");
  const [stageLabel, setStageLabel] = useState("");
  const [permalink, setPermalink] = useState("");

  function reset(): void {
    setKind("review");
    setStageId("");
    setStageLabel("");
    setPermalink("");
  }

  function handleCancel(): void {
    reset();
    onCancel();
  }

  const canConfirm =
    kind !== "deploy" || (stageId.trim() !== "" && stageLabel.trim() !== "");

  function handleConfirm(): void {
    if (!canConfirm) return;
    const trimmedPermalink = permalink.trim();
    const awaiting: AwaitingKind =
      kind === "deploy"
        ? {
            kind: "deploy",
            stageId: stageId.trim(),
            stageLabel: stageLabel.trim(),
          }
        : kind === "slack"
          ? {
              kind: "slack",
              ...(trimmedPermalink ? { permalink: trimmedPermalink } : {}),
            }
          : { kind: "review" };
    reset();
    onConfirm(awaiting);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleCancel();
      }}
      title="Why is this task awaiting?"
      testId="awaiting-reason-dialog"
    >
      <fieldset
        className="flex flex-col gap-2"
        data-testid="awaiting-reason-options"
      >
        {REASON_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="awaiting-reason"
              value={option.value}
              checked={kind === option.value}
              onChange={() => setKind(option.value)}
              data-testid={`awaiting-reason-${option.value}`}
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      {kind === "deploy" && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="awaiting-stage-id">Stage id</Label>
            <Input
              id="awaiting-stage-id"
              data-testid="awaiting-stage-id-input"
              value={stageId}
              onChange={(event) => setStageId(event.target.value)}
              placeholder="staging"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="awaiting-stage-label">Stage label</Label>
            <Input
              id="awaiting-stage-label"
              data-testid="awaiting-stage-label-input"
              value={stageLabel}
              onChange={(event) => setStageLabel(event.target.value)}
              placeholder="Staging"
            />
          </div>
        </div>
      )}

      {kind === "slack" && (
        <div className="mt-3 flex flex-col gap-1">
          <Label htmlFor="awaiting-slack-permalink">
            Slack permalink (optional)
          </Label>
          <Input
            id="awaiting-slack-permalink"
            data-testid="awaiting-slack-permalink-input"
            value={permalink}
            onChange={(event) => setPermalink(event.target.value)}
            placeholder="https://..."
          />
        </div>
      )}

      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCancel}
          data-testid="awaiting-reason-cancel"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canConfirm}
          onClick={handleConfirm}
          data-testid="awaiting-reason-confirm"
        >
          Confirm
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
