import type { JSX } from "react";
import { useEffect, useState } from "react";
import { type ConfirmRequest, subscribeConfirm } from "../confirm";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";

/** Renders the pending `requestConfirm` question (one at a time); Escape/backdrop = cancel. */
export function ConfirmHost(): JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | undefined>();
  useEffect(() => subscribeConfirm(setRequest), []);
  if (!request) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) request.resolve(false);
      }}
      title={request.title}
      testId="confirm-dialog"
    >
      <p
        className="break-words text-sm text-muted-foreground"
        data-testid="confirm-dialog-message"
      >
        {request.message}
      </p>
      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => request.resolve(false)}
          data-testid="confirm-dialog-cancel"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => request.resolve(true)}
          data-testid="confirm-dialog-confirm"
        >
          {request.confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
