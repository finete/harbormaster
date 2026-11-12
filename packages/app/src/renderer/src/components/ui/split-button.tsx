// Split button (design system "Split button": Start ▾, Open in ▾): one pill
// whose chevron half is separated by a 1px line, both halves the same fill.
// Our own composition over `buttonVariants`, so a split button picks up
// exactly the Button variant/size look. The trigger half is a plain
// <button> forwarded through `forwardRef`, so it can sit inside a Radix
// `DropdownMenuTrigger asChild`.

import type { VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";

type SplitVariant = VariantProps<typeof buttonVariants>["variant"];
type SplitSize = VariantProps<typeof buttonVariants>["size"];

const SplitContext = React.createContext<{
  variant: SplitVariant;
  size: SplitSize;
}>({ variant: "secondary", size: "sm" });

/** Divider color between the halves: `primary-foreground/20` on mint. */
function dividerClass(variant: SplitVariant): string {
  return variant === "default" || variant === undefined
    ? "border-l border-primary-foreground/20"
    : "border-l border-border";
}

/**
 * The pill: wraps a `SplitButtonMain` and a `SplitButtonTrigger`. The
 * variant's border (secondary/outline) is drawn once around the whole pill.
 */
export function SplitButton({
  variant = "secondary",
  size = "sm",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  variant?: SplitVariant;
  size?: SplitSize;
}): React.JSX.Element {
  const bordered = variant === "secondary" || variant === "outline";
  return (
    <SplitContext.Provider value={{ variant, size }}>
      <div
        className={cn(
          "inline-flex shrink-0 items-stretch rounded-lg",
          bordered && "border border-border",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SplitContext.Provider>
  );
}

/** The main (left) half: the primary action. */
export const SplitButtonMain = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => {
  const { variant, size } = React.useContext(SplitContext);
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        buttonVariants({ variant, size }),
        "rounded-r-none border-0",
        className,
      )}
      {...props}
    />
  );
});
SplitButtonMain.displayName = "SplitButtonMain";

/** The chevron (right) half: opens the alternatives menu. */
export const SplitButtonTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", children, ...props }, ref) => {
  const { variant, size } = React.useContext(SplitContext);
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        buttonVariants({ variant, size }),
        "rounded-l-none border-0 px-1.5",
        dividerClass(variant),
        className,
      )}
      {...props}
    >
      {children ?? <ChevronDown />}
    </button>
  );
});
SplitButtonTrigger.displayName = "SplitButtonTrigger";
