// Copy-in from shadcn/ui Input Group (https://ui.shadcn.com/docs/components/radix/input-group),
// the base of the AI Elements Prompt Input. Adapted to Tailwind 3 and
// re-skinned to Harbormaster's design tokens (see /AGENTS.md: shadcn/ui is
// copy-in; we own this file).

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Button, type ButtonProps } from "./button";

export function InputGroup({
  className,
  ...props
}: React.ComponentProps<"fieldset">): React.JSX.Element {
  return (
    <fieldset
      data-slot="input-group"
      className={cn(
        "group/input-group relative m-0 flex w-full min-w-0 p-0 items-center rounded-2xl border border-input bg-card/60 shadow-sm transition-[color,box-shadow]",
        "has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-end]]:flex-col",
        "has-[[data-slot=input-group-control]:focus-visible]:border-ring/60 has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20",
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "m-0 flex h-auto min-w-0 items-center gap-1.5 border-0 p-0 text-sm text-muted-foreground [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "order-first pl-3",
        "inline-end": "order-last pr-3",
        "block-start": "order-first w-full justify-start px-3 pt-3",
        "block-end": "order-last w-full justify-start px-2 pb-2",
      },
    },
    defaultVariants: { align: "inline-start" },
  },
);

export function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"fieldset"> &
  VariantProps<typeof inputGroupAddonVariants>): React.JSX.Element {
  return (
    <fieldset
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva(
  "flex items-center gap-1.5 text-xs font-normal shadow-none",
  {
    variants: {
      size: {
        xs: "h-7 rounded-lg px-2 [&>svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 rounded-lg px-2.5 [&>svg:not([class*='size-'])]:size-4",
        "icon-xs": "size-7 rounded-lg p-0",
        "icon-sm": "size-8 rounded-lg p-0",
      },
    },
    defaultVariants: { size: "xs" },
  },
);

export const InputGroupButton = React.forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "size"> & VariantProps<typeof inputGroupButtonVariants>
>(
  (
    { className, type = "button", variant = "ghost", size = "xs", ...props },
    ref,
  ) => (
    <Button
      ref={ref}
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  ),
);
InputGroupButton.displayName = "InputGroupButton";

export const InputGroupTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="input-group-control"
    className={cn(
      "w-full flex-1 resize-none border-0 bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
InputGroupTextarea.displayName = "InputGroupTextarea";
