// On/off switch (design system "Switch"): a `role="switch"` button, mint
// when on. Shared by the onboarding wizard and the Code review settings.
import type { JSX } from "react";
import { cn } from "../../lib/utils";

export function Switch({
  checked,
  onChange,
  disabled,
  testId,
  label,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  testId: string;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[120ms] ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full transition-transform duration-[120ms] ease-out",
          checked ? "bg-primary-foreground" : "bg-muted-foreground",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
