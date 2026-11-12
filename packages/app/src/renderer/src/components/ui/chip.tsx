// Chip (design system "Chip": Repository · arnac in the composer's chip
// row): a `bg-muted` hairline pill, the label in `muted-foreground`, the
// value in `foreground` medium; hover `bg-accent`. Renders a <button> so
// it can be a Popover/DropdownMenu trigger (`asChild`) for its picker.

import * as React from "react";
import { cn } from "../../lib/utils";

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  /** The muted lead-in ("Repository", "Base", "Model"). */
  label?: React.ReactNode;
  /** The chosen value; children render after it (e.g. a chevron). */
  value?: React.ReactNode;
  /** Full pill radius (the composer chip row) vs. the standard radius. */
  pill?: boolean;
}

export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(
  (
    {
      label,
      value,
      pill = true,
      className,
      children,
      type = "button",
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 border border-border bg-muted px-2.5 text-[13px] outline-none transition-colors duration-[120ms] ease-out hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        pill ? "rounded-full" : "rounded-lg",
        className,
      )}
      {...props}
    >
      {label !== undefined && (
        <span className="shrink-0 text-muted-foreground">{label}</span>
      )}
      {value !== undefined && (
        <span className="min-w-0 truncate font-medium text-foreground">
          {value}
        </span>
      )}
      {children}
    </button>
  ),
);
Chip.displayName = "Chip";
