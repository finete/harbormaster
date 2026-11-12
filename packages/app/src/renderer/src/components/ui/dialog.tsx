// Minimal shadcn-style dialog, hand-rolled (no @radix-ui/react-dialog in the
// dependency tree yet — see /AGENTS.md "pi-gui is a parts bin, not a base";
// this follows shadcn's own composition pattern, re-skinned to our tokens).
// Keyboard navigable: Escape closes, a backdrop click closes, and the first
// focusable element inside the panel is focused on open.
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  testId?: string;
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const focusable = panel?.querySelector<HTMLElement>(
      "input, select, textarea, button, [tabindex]",
    );
    focusable?.focus();
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onOpenChange(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onKeyDown={onKeyDown}
        className={cn(
          "w-[360px] rounded-lg border border-border bg-card p-4 text-card-foreground",
        )}
      >
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function DialogFooter({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>;
}
