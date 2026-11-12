// Segmented control (design system "Segmented control": Task · Review ·
// Chat in the composer, Priority · Other in the inbox). Track =
// `bg-background` with a hairline; the selected segment = `bg-muted` with a
// hairline, `font-semibold text-foreground`; the others muted. A radiogroup
// with roving arrow-key selection, our own component (shadcn has no
// segmented control; it follows the ToggleGroup look). Extra attributes
// (`data-*`) land on the track; each segment carries `data-state` and
// `data-selected`.

import type { HTMLAttributes, JSX, KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";
import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional trailing slot (a count, a `<Kbd>`). */
  trailing?: ReactNode;
  title?: string;
  testId?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  size = "default",
  className,
  ariaLabel,
  testId,
  ...props
}: Omit<
  HTMLAttributes<HTMLDivElement>,
  "role" | "onKeyDown" | "defaultValue" | "onChange"
> & {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  size?: "sm" | "default";
  className?: string;
  ariaLabel: string;
  testId?: string;
}): JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const enabled = options.filter((option) => !option.disabled);
    const index = enabled.findIndex((option) => option.value === value);
    if (index < 0) return;
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    onValueChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  }

  return (
    <div
      {...props}
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-background p-0.5",
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a styled segment, not a native radio input; role + aria-checked carry the semantics.
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            data-state={selected ? "on" : "off"}
            data-selected={selected ? "true" : "false"}
            data-testid={option.testId}
            title={option.title}
            disabled={option.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-md border px-3 outline-none transition-colors duration-[120ms] ease-out focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              size === "sm" ? "h-6 text-xs" : "h-7 text-[13px]",
              selected
                ? "border-border bg-muted font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.trailing}
          </button>
        );
      })}
    </div>
  );
}
