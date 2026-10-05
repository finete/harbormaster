import { X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { dismissToast, subscribeToasts, type ToastMessage } from "../toast";

/**
 * Fixed-position stack of dismissible banners (errors thrown by task
 * actions, warnings returned by `toDone`/`refresh`). One instance lives at
 * the top of `App.tsx`; every toast in the app flows through the module-level
 * bus in `toast.ts`.
 */
export function ToastHost(): JSX.Element {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return <div data-testid="toast-host" />;

  return (
    <div
      data-testid="toast-host"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid={`toast-${toast.tone}`}
          className={cn(
            "pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg",
            toast.tone === "error"
              ? "border-red-900 bg-red-950 text-red-200"
              : "border-yellow-900 bg-yellow-950 text-yellow-200",
          )}
        >
          <span className="flex-1">{toast.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="toast-dismiss"
            onClick={() => dismissToast(toast.id)}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
