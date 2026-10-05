import type { JSX } from "react";
import type { PresenceSnapshot } from "../../../preload/api";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";

/**
 * Takeover-offer guard (see /AGENTS.md "Attachment safety" and
 * /docs/design-decisions.md #8), ported from pi-home's `openGuarded`: Pi
 * sessions have no concurrent-attachment protection, so opening/focusing a
 * task whose presence is live and not owned by one of this app's own panes
 * must go through this dialog first. Own-pane live tasks never reach here
 * (the caller just focuses the panel \u2014 see App.tsx).
 */
export function TakeoverDialog({
  open,
  taskTitle,
  presence,
  onCancel,
  onAttachAnyway,
}: {
  open: boolean;
  taskTitle: string;
  presence: PresenceSnapshot | null;
  onCancel: () => void;
  onAttachAnyway: () => void;
}): JSX.Element | null {
  if (!open || !presence?.record) return null;
  const record = presence.record;
  const headless = record.mode === "headless";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={
        headless
          ? `An agent is working headless on \u201c${taskTitle}\u201d`
          : `\u201c${taskTitle}\u201d is attached elsewhere`
      }
      testId="takeover-dialog"
    >
      {headless ? (
        <p className="text-sm text-muted-foreground">
          This task's headless run is still active. Stopping it from here isn't
          supported yet.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          This task appears attached in another process (pid {record.pid}).
          Attaching here too is unsafe \u2014 Pi sessions have no
          concurrent-attachment protection.
        </p>
      )}
      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          data-testid="takeover-cancel"
        >
          Cancel
        </Button>
        {headless ? (
          <Button
            size="sm"
            disabled
            title="coming soon"
            data-testid="takeover-stop-and-attach"
          >
            Stop run and attach
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onAttachAnyway}
            data-testid="takeover-attach-anyway"
          >
            Attach here anyway
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
