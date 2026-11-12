// Chip (design system "Chip": Repository · arnac in the composer's chip
// row): a `bg-muted` hairline pill, the label in `muted-foreground`, the
// value in `foreground` medium; hover (and open) `bg-accent`. Renders a
// <button> so it can be a Popover/DropdownMenu trigger (`asChild`) for its
// picker; `readOnly` renders a plain <span> (a value the user can't change
// here, e.g. one derived from a pull request).
//
// A value is never ellipsized (`data-chip-value`, `whitespace-nowrap`): the
// row the chips sit in wraps instead. Only a chip wider than its whole row
// is clipped (`max-w-full`), and then `overflowTitle` becomes its tooltip,
// the last resort; an unclipped chip shows only its own `title` (a hint).

import * as React from "react";
import { cn } from "../../lib/utils";

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  /** The muted lead-in ("Repository", "Base", "Model"). */
  label?: React.ReactNode;
  /** The chosen value; children render after it (e.g. a chevron). */
  value?: React.ReactNode;
  /** `data-testid` of the value span. */
  valueTestId?: string | undefined;
  /** Extra classes for the value span (e.g. an attention color). */
  valueClassName?: string | undefined;
  /** Tooltip shown only while the chip is clipped (wider than its row). */
  overflowTitle?: string | undefined;
  /** Not a trigger: a <span> with `data-readonly`, no hover. */
  readOnly?: boolean;
  /** Full pill radius (the composer chip row) vs. the standard radius. */
  pill?: boolean;
}

/** A chip's value span; use directly for extra values after the first. */
export function ChipValue({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  "data-testid"?: string | undefined;
}): React.JSX.Element {
  return (
    <span
      data-chip-value=""
      className={cn(
        "shrink-0 whitespace-nowrap font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(
  (
    {
      label,
      value,
      valueTestId,
      valueClassName,
      overflowTitle,
      readOnly = false,
      pill = true,
      className,
      children,
      title,
      type = "button",
      onPointerEnter,
      ...props
    },
    ref,
  ) => {
    const [clipped, setClipped] = React.useState(false);
    const shownTitle =
      clipped && overflowTitle
        ? title
          ? `${overflowTitle}\n${title}`
          : overflowTitle
        : title;
    const measure = (element: HTMLElement): void =>
      setClipped(element.scrollWidth > element.clientWidth);
    const classes = cn(
      "inline-flex h-7 min-w-0 max-w-full shrink-0 items-center gap-1.5 overflow-hidden border border-border bg-muted px-2.5 text-[13px] outline-none transition-colors duration-[120ms] ease-out [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
      readOnly
        ? "cursor-default"
        : "hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent",
      pill ? "rounded-full" : "rounded-lg",
      className,
    );
    const body = (
      <>
        {label !== undefined && (
          <span className="shrink-0 text-muted-foreground">{label}</span>
        )}
        {value !== undefined && (
          <ChipValue data-testid={valueTestId} className={valueClassName}>
            {value}
          </ChipValue>
        )}
        {children}
      </>
    );
    if (readOnly) {
      const { onClick: _onClick, ...rest } = props;
      return (
        <span
          {...(rest as React.HTMLAttributes<HTMLSpanElement>)}
          data-readonly="true"
          title={shownTitle}
          onPointerEnter={(event) => measure(event.currentTarget)}
          className={classes}
        >
          {body}
        </span>
      );
    }
    return (
      <button
        ref={ref}
        type={type}
        title={shownTitle}
        onPointerEnter={(event) => {
          measure(event.currentTarget);
          onPointerEnter?.(event);
        }}
        className={classes}
        {...props}
      >
        {body}
      </button>
    );
  },
);
Chip.displayName = "Chip";
