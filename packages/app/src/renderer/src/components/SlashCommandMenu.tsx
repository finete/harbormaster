import type { JSX } from "react";
import { useEffect, useRef } from "react";
import type { SlashCommand } from "../../../preload/api";

/**
 * The composer's `/` menu (docs/new-task-composer.md "Slash commands"): a
 * listbox under the prompt box. Focus never leaves the prompt; the
 * composer drives the highlighted row from the prompt's keys and points
 * `aria-activedescendant` at `${id}-${activeIndex}`. A press picks (on
 * mousedown, so the prompt keeps focus).
 */
export function SlashCommandMenu({
  id,
  entries,
  activeIndex,
  status,
  onPick,
  onHover,
}: {
  id: string;
  entries: readonly SlashCommand[];
  activeIndex: number;
  /** A line shown instead of (or, with entries, under) the list: loading, nothing to list, a failed listing. */
  status?: string | undefined;
  onPick: (entry: SlashCommand) => void;
  onHover: (index: number) => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      data-testid="slash-command-menu"
      className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
    >
      {entries.length > 0 && (
        <div
          ref={listRef}
          id={id}
          role="listbox"
          aria-label="Skills and commands"
          className="max-h-72 overflow-y-auto p-1"
        >
          {entries.map((entry, index) => (
            <div
              key={entry.command}
              id={`${id}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              data-index={index}
              data-selected={index === activeIndex}
              data-testid="slash-command-option"
              data-command={entry.command}
              title={entry.description}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(entry);
              }}
              onMouseMove={() => {
                if (index !== activeIndex) onHover(index);
              }}
              className="flex cursor-default select-none items-baseline gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
            >
              <span className="shrink-0 font-mono text-[12px]">
                {entry.command}
              </span>
              {entry.argumentHint && (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {entry.argumentHint}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                {entry.description}
              </span>
              <span className="max-w-[30%] shrink-0 truncate text-[10px] text-muted-foreground/70">
                {entry.plugin ?? entry.source}
              </span>
            </div>
          ))}
        </div>
      )}
      {status && (
        <div
          data-testid="slash-command-status"
          className={
            entries.length > 0
              ? "border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground"
              : "px-3 py-2.5 text-[12px] text-muted-foreground"
          }
        >
          {status}
        </div>
      )}
    </div>
  );
}
