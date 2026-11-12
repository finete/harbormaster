import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import {
  capVisibleToasts,
  dismissToast,
  subscribeToasts,
  TOAST_VISIBLE_CAP,
  type ToastMessage,
} from "../toast";

/**
 * Fixed-position stack of dismissible banners (errors thrown by task
 * actions, warnings returned by `toDone`/`refresh`). One instance lives at
 * the top of `App.tsx`; every toast in the app flows through the
 * module-level bus in `toast.ts`.
 *
 * Hygiene: the stack is capped (`capVisibleToasts`) so a long run of
 * distinct warnings never grows into an undismissable wall — the rest
 * collapse behind a "+N more" row the owner can expand on demand.
 */
export function ToastHost(): JSX.Element {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => subscribeToasts(setToasts), []);
  // A fresh push (new toast, or the stack shrinking back under the cap)
  // collapses the "+N more" row again, so it never stays stuck open once
  // there is nothing left to hide.
  useEffect(() => {
    if (toasts.length <= TOAST_VISIBLE_CAP) setExpanded(false);
  }, [toasts.length]);

  if (toasts.length === 0) return <div data-testid="toast-host" />;

  const { visible, overflow } = capVisibleToasts(toasts);
  const shown = expanded ? toasts : visible;

  return (
    <div
      data-testid="toast-host"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
    >
      {shown.map((toast) => (
        <div
          key={toast.id}
          data-testid={`toast-${toast.tone}`}
          className={cn(
            // Surface card + a status-tinted hairline and text: error =
            // status-error, success = status-ok, warning = needs-you.
            "pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border bg-card px-3 py-2 text-sm",
            toast.tone === "error"
              ? "border-status-error/50 text-status-error"
              : toast.tone === "success"
                ? "border-status-ok/50 text-status-ok"
                : "border-status-needsYou/50 text-status-needsYou",
          )}
        >
          <span className="flex-1">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              data-testid="toast-action"
              onClick={() => {
                toast.action?.run();
                dismissToast(toast.id);
              }}
              className="shrink-0 font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="toast-dismiss"
            onClick={() => dismissToast(toast.id)}
            className="shrink-0 rounded text-muted-foreground transition-colors duration-[120ms] ease-out hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {overflow.length > 0 && (
        <button
          type="button"
          data-testid="toast-overflow"
          onClick={() => setExpanded((value) => !value)}
          className="pointer-events-auto flex items-center justify-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              Show less
            </>
          ) : (
            <>
              <ChevronUp className="h-3.5 w-3.5" />+{overflow.length} more
            </>
          )}
        </button>
      )}
    </div>
  );
}
