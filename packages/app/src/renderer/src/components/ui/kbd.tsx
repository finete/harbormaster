import type { JSX, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Small muted key-cap chip, used both inside buttons (hint for their
 * keyboard shortcut) and in the board's key legend strip. Copy-in shadcn
 * pattern (see AGENTS.md "pi-gui is a parts bin, not a base" — this one is
 * our own, not lifted).
 */
export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <kbd
      className={cn(
        "rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] font-normal leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
