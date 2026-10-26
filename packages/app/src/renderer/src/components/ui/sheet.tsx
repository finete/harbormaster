// Minimal shadcn-style side sheet, hand-rolled like `dialog.tsx` (no
// @radix-ui/react-dialog in the dependency tree). Opens only on an explicit
// user action and never moves focus on its own; Escape closes it (while
// focus is inside) and a backdrop click closes it. Keys pressed inside the
// panel stop at it, so the board's single-key shortcuts never fire through
// an open sheet.
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Sheet({
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
  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key === "Escape") onOpenChange(false);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40">
      <button
        type="button"
        aria-label={`Close ${title}`}
        tabIndex={-1}
        data-testid={testId ? `${testId}-backdrop` : undefined}
        className="absolute inset-0 cursor-default"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-label={title}
        data-testid={testId}
        onKeyDown={onKeyDown}
        className={cn(
          "relative flex h-full w-[440px] max-w-full flex-col border-l border-border bg-card text-card-foreground shadow-xl",
        )}
      >
        {children}
      </div>
    </div>
  );
}
