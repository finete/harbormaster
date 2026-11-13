// Copy-in from shadcn/ui (https://ui.shadcn.com/docs/components/badge),
// re-skinned to Harbormaster's design tokens.

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

// Design system "Badges / pills": 12px text, full pill radius, status fill
// at 12–20% with a 35–50% stroke of the same hue. Status hues come only from
// the `status-*` tokens; neutral states use the grey ramp.
export const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium transition-colors duration-[120ms] ease-out",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-border bg-muted text-muted-foreground",
        outline: "border-border text-foreground",
        /** status: ok (your move, PR open/approved, done-wants-a-look). */
        ok: "border-status-ok/50 bg-status-ok/20 text-status-ok",
        /** status: working (an agent turn is running). */
        working:
          "border-status-working/45 bg-status-working/15 text-status-working",
        /** status: needs-you (asked, blocked, warnings). */
        needsYou:
          "border-status-needsYou/45 bg-status-needsYou/15 text-status-needsYou",
        /** status: error (failed, closed). */
        error: "border-status-error/45 bg-status-error/15 text-status-error",
        /** status: neutral/info (idle, draft). */
        neutral: "border-border bg-muted text-muted-foreground",
        // PR-state aliases (pr-badge.ts maps PR states onto these names).
        success: "border-status-ok/50 bg-status-ok/20 text-status-ok",
        draft: "border-border bg-muted text-muted-foreground",
        merged: "border-status-ok/35 bg-status-ok/10 text-status-ok",
        closed: "border-status-error/45 bg-status-error/15 text-status-error",
        changes:
          "border-status-needsYou/45 bg-status-needsYou/15 text-status-needsYou",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({
  className,
  variant,
  ...props
}: BadgeProps): React.JSX.Element {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
