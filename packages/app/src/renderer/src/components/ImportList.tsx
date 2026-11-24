import { ChevronDown, Loader2 } from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import type {
  ImportCandidate,
  ImportCandidateGroup,
  ImportCandidateSession,
} from "../../../preload/api";
import { harnessLabelFrom, useHarnessDescriptors } from "../lib/harnesses";
import {
  canOfferFork,
  groupState,
  hiddenCount,
  otherSessionsLabel,
  pickedSession,
  rowBlock,
  rowLabels,
  rowTitle,
  sourceFootnote,
  titleHint,
  visibleGroups,
} from "../lib/import-list";
import { relativeTime } from "../lib/time-format";
import type { ImportListModel } from "../lib/use-import-list";
import { useNow } from "../lib/use-now";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** A harness's glyph: its initials in a hairline square (the label is the tooltip). */
function AgentGlyph({
  harness,
  label,
}: {
  harness: string;
  label: string;
}): JSX.Element {
  const words = label.split(/\s+/).filter(Boolean);
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word[0])
          .join("")
      : label.slice(0, 2);
  return (
    <span
      data-testid="import-agent-icon"
      data-harness={harness}
      title={label}
      className="flex h-5 w-6 shrink-0 items-center justify-center rounded border border-border bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
    >
      {initials}
    </span>
  );
}

function ago(iso: string, now: number): string {
  const text = relativeTime(iso, now);
  return text === "now" || text === "" ? "just now" : `${text} ago`;
}

function SessionPicker({
  candidate,
  model,
  labelOf,
  now,
}: {
  candidate: ImportCandidate;
  model: ImportListModel;
  labelOf: (harness: string) => string;
  now: number;
}): JSX.Element | null {
  const label = otherSessionsLabel(candidate);
  if (!label) return null;
  const picked = pickedSession(candidate, model.choices);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`import-sessions-${candidate.id}`}
          className="inline-flex items-center gap-0.5 rounded px-1 text-xs text-muted-foreground underline-offset-2 hover:bg-accent hover:text-foreground"
        >
          {label}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-1" data-testid="import-session-picker">
        {candidate.sessions.map((session: ImportCandidateSession) => (
          <button
            key={session.sessionId}
            type="button"
            data-testid={`import-session-${candidate.id}-${session.sessionId}`}
            aria-pressed={session.sessionId === picked.sessionId}
            onClick={() => model.pick(candidate, session.sessionId)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
              session.sessionId === picked.sessionId && "bg-accent",
            )}
          >
            <AgentGlyph
              harness={session.harness}
              label={labelOf(session.harness)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">
                {session.title ?? "Untitled session"}
              </span>
              <span className="block text-muted-foreground">
                {ago(session.lastActiveAt, now)} · {session.userPrompts}{" "}
                {session.userPrompts === 1 ? "prompt" : "prompts"}
                {session.running ? " · running" : ""}
              </span>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Row({
  candidate,
  model,
  labelOf,
  now,
}: {
  candidate: ImportCandidate;
  model: ImportListModel;
  labelOf: (harness: string) => string;
  now: number;
}): JSX.Element {
  const { choices } = model;
  const session = pickedSession(candidate, choices);
  const block = rowBlock(candidate, choices);
  const checked = choices.selected.has(candidate.id);
  const forking = choices.forks.has(candidate.id);
  const labels = rowLabels(candidate);
  const harnesses = [
    session.harness,
    ...candidate.sessions
      .map((entry) => entry.harness)
      .filter((harness) => harness !== session.harness),
  ].filter((harness, index, all) => all.indexOf(harness) === index);

  return (
    <div
      data-testid={`import-row-${candidate.id}`}
      data-checked={checked ? "true" : "false"}
      data-blocked={block ?? ""}
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2 py-1.5 focus-within:bg-accent/40",
        block && "opacity-70",
      )}
    >
      {/* The native checkbox is the row's one tab stop: Space toggles it, Enter imports. */}
      <input
        type="checkbox"
        className="mt-1.5 h-3.5 w-3.5 shrink-0 accent-primary"
        data-testid={`import-check-${candidate.id}`}
        aria-label={`Import ${rowTitle(candidate, choices)}`}
        checked={checked}
        disabled={block !== undefined}
        onChange={() => model.toggle(candidate)}
      />
      <span className="mt-1 flex shrink-0 gap-0.5">
        {harnesses.map((harness) => (
          <AgentGlyph
            key={harness}
            harness={harness}
            label={labelOf(harness)}
          />
        ))}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <input
            type="text"
            data-testid={`import-title-${candidate.id}`}
            aria-label="Task title"
            value={rowTitle(candidate, choices)}
            disabled={block === "on-board"}
            onChange={(event) => model.rename(candidate, event.target.value)}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-foreground hover:border-input focus-visible:border-primary focus-visible:outline-none disabled:opacity-60"
          />
          <span
            data-testid="import-hint"
            className="shrink-0 text-[11px] text-muted-foreground/70"
          >
            {titleHint(candidate.titleSource)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-xs text-muted-foreground">
          <span className="font-mono">
            {candidate.branch ?? candidate.folderPath}
          </span>
          <span>{ago(candidate.lastActiveAt, now)}</span>
          {labels.map((label) => (
            <span
              key={label}
              data-testid="import-label"
              className="rounded-full border border-border px-1.5 text-[11px]"
            >
              {label}
            </span>
          ))}
          <SessionPicker
            candidate={candidate}
            model={model}
            labelOf={labelOf}
            now={now}
          />
        </div>
        {session.running && (
          <div
            data-testid={`import-running-${candidate.id}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-0.5 text-xs text-muted-foreground"
          >
            <span data-testid="import-running-message">
              {session.running.message}
            </span>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`import-check-again-${candidate.id}`}
              onClick={model.refresh}
            >
              Check again
            </Button>
            {canOfferFork(candidate, choices) &&
              (forking ? (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid={`import-unfork-${candidate.id}`}
                  title="Back to a plain running row"
                  onClick={() => model.unfork(candidate)}
                >
                  Forking: undo
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid={`import-fork-${candidate.id}`}
                  title="Import a copy of the session instead; the running one is left alone"
                  onClick={() => model.fork(candidate)}
                >
                  Fork instead
                </Button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Group({
  group,
  model,
  labelOf,
  now,
}: {
  group: ImportCandidateGroup;
  model: ImportListModel;
  labelOf: (harness: string) => string;
  now: number;
}): JSX.Element {
  const state = groupState(group, model.choices);
  return (
    <section data-testid={`import-group-${group.id}`}>
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-card px-2 py-1">
        <input
          type="checkbox"
          aria-label={`Select all in ${group.label}`}
          data-testid={`import-group-all-${group.id}`}
          className="h-3.5 w-3.5 accent-primary"
          checked={state === "all"}
          disabled={state === "empty"}
          ref={(element) => {
            if (element) element.indeterminate = state === "some";
          }}
          onChange={() => model.toggleGroupOf(group)}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {group.label}
        </span>
        <span
          data-testid="import-group-count"
          className="text-[11px] text-muted-foreground"
        >
          {group.candidates.length}
        </span>
      </header>
      {group.candidates.map((candidate) => (
        <Row
          key={candidate.id}
          candidate={candidate}
          model={model}
          labelOf={labelOf}
          now={now}
        />
      ))}
    </section>
  );
}

/**
 * The shared import list (docs/import.md "UI"): rows grouped by repository,
 * newest first, with the footer toggles ("Show older", "Show hidden (n)") and
 * the quiet source footnote. The host (Import… dialog, wizard step) owns the
 * Import button and reads the count from the model. Enter on a row (not in a
 * text field) calls `onSubmit`; Space toggles the focused row.
 */
export function ImportList({
  model,
  onSubmit,
  className,
}: {
  model: ImportListModel;
  onSubmit?: () => void;
  className?: string;
}): JSX.Element {
  const now = useNow();
  const descriptors = useHarnessDescriptors();
  const labelOf = (harness: string): string =>
    harnessLabelFrom(descriptors, harness);
  const { listing } = model;
  const groups = listing ? visibleGroups(listing.groups, model.showHidden) : [];
  const hidden = listing ? hiddenCount(listing.groups) : 0;
  const footnote = listing ? sourceFootnote(listing.sources) : undefined;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" || !onSubmit) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "BUTTON") return;
    if (target instanceof HTMLInputElement && target.type !== "checkbox")
      return;
    event.preventDefault();
    onSubmit();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: key boundary (Enter imports) for the rows inside.
    <div
      data-testid="import-list"
      data-loading={model.loading ? "true" : "false"}
      onKeyDown={onKeyDown}
      className={cn("flex min-h-0 flex-col", className)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!listing && model.loading && (
          <p className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Looking for recent sessions…
          </p>
        )}
        {model.error && (
          <p
            data-testid="import-error"
            className="px-2 py-3 text-sm text-destructive"
          >
            Could not read your sessions: {model.error}
          </p>
        )}
        {listing && groups.length === 0 && (
          <p
            data-testid="import-empty"
            className="px-2 py-3 text-sm text-muted-foreground"
          >
            No recent sessions found
          </p>
        )}
        {groups.map((group) => (
          <Group
            key={group.id}
            group={group}
            model={model}
            labelOf={labelOf}
            now={now}
          />
        ))}
      </div>
      {listing && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="import-show-older"
              className="h-3.5 w-3.5 accent-primary"
              checked={model.includeOlder}
              onChange={(event) => model.setIncludeOlder(event.target.checked)}
            />
            Show older
          </label>
          {(hidden > 0 || model.showHidden) && (
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="import-show-hidden"
                className="h-3.5 w-3.5 accent-primary"
                checked={model.showHidden}
                onChange={(event) => model.setShowHidden(event.target.checked)}
              />
              Show hidden ({hidden})
            </label>
          )}
          {model.loading && (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          )}
          {footnote && (
            <span data-testid="import-footnote" className="opacity-70">
              {footnote}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
