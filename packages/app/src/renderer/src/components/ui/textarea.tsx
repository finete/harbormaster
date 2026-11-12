// Copy-in from shadcn/ui (https://ui.shadcn.com/docs/components/textarea),
// re-skinned to Harbormaster's design tokens.
import * as React from "react";
import { cn } from "../../lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[72px] w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors duration-[120ms] ease-out placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
