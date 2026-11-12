import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { type ConfirmRequest, subscribeConfirm } from "../confirm";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";

/** Renders the pending `requestConfirm` question (one at a time); Escape/backdrop = cancel. */
export function ConfirmHost(): JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | undefined>();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => subscribeConfirm(setRequest), []);
  // Runs after the Dialog's own focus-the-first-button effect (children's
  // effects run first), so an Enter-confirms question focuses its confirm
  // button and Enter presses it.
  const enterConfirms = request?.enterConfirms === true;
  const requestId = request?.id;
  useEffect(() => {
    if (requestId && enterConfirms) confirmRef.current?.focus();
  }, [requestId, enterConfirms]);
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
      {request.message && (
        <p
          className="break-words text-sm text-muted-foreground"
          data-testid="confirm-dialog-message"
        >
          {request.message}
        </p>
      )}
      {request.lines?.map((line) => (
        <p
          key={line}
          className="break-words text-sm text-muted-foreground"
          data-testid="confirm-dialog-line"
        >
          {line}
        </p>
      ))}
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
          ref={confirmRef}
          onClick={() => request.resolve(true)}
          data-testid="confirm-dialog-confirm"
          {...(enterConfirms
            ? { title: `${request.confirmLabel} (Enter)` }
            : {})}
        >
          {request.confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
