// Copy-in from shadcn/ui Popover (https://ui.shadcn.com/docs/components/radix/popover),
// adapted to Tailwind 3 (no enter/exit animations) and re-skinned to
// Harbormaster's design tokens.

import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { cn } from "../../lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-lg border border-border bg-popover p-0 text-popover-foreground outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
