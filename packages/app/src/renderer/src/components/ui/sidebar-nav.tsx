import type { JSX, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Kbd } from "./kbd";

/**
 * One top-of-sidebar navigation row (New task / Board / Inbox), the stacked
 * nav list modern agent apps put above their thread list (Claude desktop,
 * Codex, Orca). Copy-in of shadcn's `SidebarMenuButton` look (ghost row,
 * h-8, p-2, gap-2, rounded-md, 16px icon, accent hover, trailing
 * `SidebarMenuBadge`), re-skinned to our tokens; no SidebarProvider needed.
 *
 * The trailing slot shows the badge when there is one, otherwise the
 * keyboard hint (muted, fully visible on hover). `compact` renders the
 * icon-only variant for the collapsed rail, with the badge as a corner dot
 * count.
 */
export function SidebarNavItem({
  icon,
  label,
  onClick,
  shortcut,
  badge,
  active = false,
  compact = false,
  testId,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  shortcut?: string;
  /** Count to surface (hidden at 0/undefined). */
  badge?: number;
  active?: boolean;
  compact?: boolean;
  testId?: string;
  title?: string;
}): JSX.Element {
  const hasBadge = badge !== undefined && badge > 0;
  const tooltip = title ?? (shortcut ? `${label} (${shortcut})` : label);
  if (compact) {
    return (
      <button
        type="button"
        data-testid={testId}
        data-active={active}
        aria-label={hasBadge ? `${label}: ${badge}` : label}
        title={tooltip}
        onClick={onClick}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60 [&>svg]:size-4",
          active && "bg-accent/70 text-foreground",
        )}
      >
        {icon}
        {hasBadge && (
          <span
            data-testid={testId ? `${testId}-count` : undefined}
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none tabular-nums text-primary-foreground"
          >
            {badge}
          </span>
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active}
      aria-label={hasBadge ? `${label}: ${badge}` : label}
      title={tooltip}
      onClick={onClick}
      className={cn(
        "group/nav flex h-8 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60 [&>svg]:size-4 [&>svg]:shrink-0",
        active && "bg-accent/70 font-medium text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hasBadge ? (
        <span
          data-testid={testId ? `${testId}-count` : undefined}
          className="flex h-5 min-w-5 items-center justify-center rounded-md bg-primary/90 px-1.5 text-xs font-medium tabular-nums text-primary-foreground"
        >
          {badge}
        </span>
      ) : shortcut ? (
        <Kbd className="opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100">
          {shortcut}
        </Kbd>
      ) : null}
    </button>
  );
}
