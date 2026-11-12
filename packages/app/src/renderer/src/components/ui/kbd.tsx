import type { JSX, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Key-cap hint, used inside buttons (their keyboard shortcut), in menus and
 * in the board's key legend. Design system: 20px tall, `bg-foreground/8`,
 * hairline, mono 11px, muted text. Our own component (see AGENTS.md
 * "pi-gui is a parts bin, not a base").
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
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-foreground/[0.08] px-1 font-mono text-[11px] font-normal leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
