// Copy-in from shadcn/ui (https://ui.shadcn.com/docs/components/button),
// re-skinned to Harbormaster's design tokens per /AGENTS.md ("pi-gui is a
// parts bin, not a base" — this component is shadcn's own pattern, not
// lifted from pi-gui, but the copy-in-ownership rule applies the same way).

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

// Design system (docs/design-system.md "Button"): `default` = mint fill,
// `secondary` = muted fill + hairline (the workhorse), `outline` = rare
// tertiary, `ghost` = text-only, `destructive` = error fill. Sizes 28/32/36px;
// icons 14px at `sm`, 16px otherwise (unless the call site sizes them).
// Motion: 120ms ease-out on color changes only; pressed = translate-y-px.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors duration-[120ms] ease-out active:translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 [&_kbd]:border-primary-foreground/20 [&_kbd]:bg-primary-foreground/10 [&_kbd]:text-primary-foreground/70",
        secondary:
          "border border-border bg-secondary text-secondary-foreground hover:bg-accent",
        outline:
          "border border-border bg-transparent text-foreground hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        destructive: "bg-status-error text-background hover:bg-status-error/90",
      },
      size: {
        sm: "h-7 gap-1.5 px-2.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-8 px-3 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-9 px-4 [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
