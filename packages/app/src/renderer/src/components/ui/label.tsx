// Copy-in from shadcn/ui (https://ui.shadcn.com/docs/components/label),
// re-skinned to Harbormaster's design tokens.
import * as React from "react";
import { cn } from "../../lib/utils";

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper; htmlFor/children are supplied by every call site, not visible to the linter through this prop spread.
  <label
    ref={ref}
    className={cn(
      "text-xs font-medium leading-none text-muted-foreground",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";
