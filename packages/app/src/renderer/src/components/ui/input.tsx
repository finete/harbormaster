// Copy-in from shadcn/ui (https://ui.shadcn.com/docs/components/input),
// re-skinned to Harbormaster's design tokens.
import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-8 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm text-foreground transition-colors duration-[120ms] ease-out placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
