import { AlertTriangle } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { type ConfirmRequest, subscribeConfirm } from "../confirm";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";

/** Renders the pending `requestConfirm` question (one at a time); Escape/backdrop = cancel. */
export function ConfirmHost(): JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | undefined>();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // The opt-in checkbox is tied to the question that was open when it was
  // ticked, so every newly opened question starts unchecked.
  const [ticked, setTicked] = useState<{ id: string; checked: boolean }>();
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
  const optionChecked = ticked?.id === request.id && ticked.checked;
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
      {request.option && (
        <div
          className="flex flex-col gap-1"
          data-testid="confirm-dialog-option"
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={optionChecked}
              onChange={(event) =>
                setTicked({ id: request.id, checked: event.target.checked })
              }
              data-testid={request.option.testId}
            />
            {request.option.label}
          </label>
          <p
            className="flex items-start gap-1.5 pl-5 text-xs text-status-needsYou"
            data-testid="confirm-dialog-option-warning"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            {request.option.warning}
          </p>
        </div>
      )}
      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => request.resolve(false)}
          data-testid="confirm-dialog-cancel"
        >
          {request.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          ref={confirmRef}
          onClick={() => request.resolve(true, optionChecked)}
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
