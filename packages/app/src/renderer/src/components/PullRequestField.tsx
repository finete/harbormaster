// The new-task composer's pull-request block (docs/new-task-composer.md
// "Review mode"): the first control under the title in Review mode, or what
// Task mode's "Attach a PR…" reveals. A pasted URL is looked up through core
// (`previewPullRequest`, GitHub access in core; never gh from the
// renderer): a spinner while resolving, the error inline (the field stays
// editable), and once resolved a compact card
// `#<n> · <title> · by <author> · <head> → <base>` with a remove (×).
// Review mode adds the `Author | Reviewer` segment (default from the PR).
import { GitPullRequest, Loader2, X } from "lucide-react";
import type { JSX, Ref } from "react";
import { useEffect, useState } from "react";
import type { PullRequestPreview, PullRequestRole } from "../../../preload/api";
import type { PrLookup } from "../lib/new-task-draft";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Segmented } from "./ui/segmented";

/** Pause after the last keystroke before asking GitHub. */
const LOOKUP_DEBOUNCE_MS = 250;

/** Resolved lookups by trimmed URL: switching modes or re-opening a draft never refetches. */
const resolvedCache = new Map<string, PullRequestPreview>();

function ipcErrorText(thrown: unknown): string {
  const text = thrown instanceof Error ? thrown.message : String(thrown);
  // Electron prefixes rejected IPC handlers with "Error invoking remote method '…': Error: ".
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** Core's lookup of `url` while `enabled`; `null` when there is nothing to look up. */
export function usePullRequestLookup(
  url: string,
  enabled: boolean,
): PrLookup | null {
  const trimmed = enabled ? url.trim() : "";
  const [result, setResult] = useState<{
    url: string;
    lookup: PrLookup;
  } | null>(null);
  useEffect(() => {
    if (!trimmed || resolvedCache.has(trimmed)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.harbormaster.core
        .previewPullRequest(trimmed)
        .then((pr) => {
          resolvedCache.set(trimmed, pr);
          if (!cancelled) {
            setResult({ url: trimmed, lookup: { status: "resolved", pr } });
          }
        })
        .catch((thrown: unknown) => {
          if (!cancelled) {
            setResult({
              url: trimmed,
              lookup: { status: "error", message: ipcErrorText(thrown) },
            });
          }
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed]);
  if (!trimmed) return null;
  const cached = resolvedCache.get(trimmed);
  if (cached) return { status: "resolved", pr: cached };
  return result?.url === trimmed ? result.lookup : { status: "resolving" };
}

const ROLE_HINTS: Record<PullRequestRole, string> = {
  author: "Your PR: continues on its head branch; Await review pushes to it",
  reviewer:
    "Someone else's PR: checks out its head; never pushes or opens a PR",
};

/** `#7 · Fix login · by octo · feature-login → main`, leaving out what GitHub did not say. */
export function pullRequestSummary(pr: PullRequestPreview): string {
  return [
    `#${pr.number}`,
    pr.title,
    pr.author ? `by ${pr.author}` : undefined,
    pr.headRefName ? `${pr.headRefName} \u2192 ${pr.baseRefName}` : undefined,
  ]
    .filter(Boolean)
    .join(" \u00B7 ");
}

export function PullRequestField({
  url,
  lookup,
  mode,
  role,
  roleOverridden,
  inputRef,
  autoFocus,
  onChange,
  onRemove,
}: {
  url: string;
  lookup: PrLookup | null;
  /** Review mode shows the role segment; Task mode's attached PR is always author. */
  mode: "review" | "task";
  /** The effective role (see `effectivePrRole`). */
  role: PullRequestRole;
  /** Whether the user picked the role (vs. the PR's default). */
  roleOverridden: boolean;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  onChange: (patch: { prUrl?: string; prRole?: PullRequestRole | "" }) => void;
  /** × on the card (and on Task mode's bare field): drop the PR. */
  onRemove: () => void;
}): JSX.Element {
  const resolved = lookup?.status === "resolved" ? lookup.pr : null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="new-task-pr">
      {resolved ? (
        <div
          data-testid="new-task-pr-card"
          data-number={resolved.number}
          className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted/40 py-1 pl-2.5 pr-1 text-xs text-foreground"
        >
          <GitPullRequest
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span
            data-testid="new-task-pr-summary"
            className="min-w-0 flex-1 break-words"
            title={resolved.url}
          >
            {pullRequestSummary(resolved)}
          </span>
          {mode === "review" ? (
            <Segmented
              ariaLabel="Role"
              testId="new-task-pr-role"
              data-role={role}
              size="sm"
              value={role}
              onValueChange={(next) => onChange({ prRole: next })}
              options={(["author", "reviewer"] as const).map((option) => ({
                value: option,
                label: option === "author" ? "Author" : "Reviewer",
                title: `${ROLE_HINTS[option]}${
                  role === option && !roleOverridden ? " (from the PR)" : ""
                }`,
                testId: `new-task-pr-role-${option}`,
              }))}
            />
          ) : (
            <span
              className="shrink-0 text-[11px] text-muted-foreground"
              title={ROLE_HINTS.author}
            >
              as author
            </span>
          )}
          <button
            type="button"
            data-testid="new-task-pr-remove"
            aria-label="Remove pull request"
            title="Remove pull request"
            onClick={onRemove}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <GitPullRequest
              className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={inputRef}
              autoFocus={autoFocus}
              data-testid="new-task-pr-url-input"
              aria-label="Pull request URL"
              aria-invalid={lookup?.status === "error"}
              value={url}
              onChange={(event) => onChange({ prUrl: event.target.value })}
              placeholder={
                mode === "review"
                  ? "Pull request URL to review (https://github.com/org/repo/pull/12)"
                  : "Pull request URL: continue your own PR"
              }
              className={cn(
                "pl-8 pr-8 text-[13px]",
                lookup?.status === "error" && "border-status-error/60",
              )}
            />
            {lookup?.status === "resolving" && (
              <Loader2
                data-testid="new-task-pr-spinner"
                aria-label="Looking up the pull request"
                className="absolute right-2.5 size-3.5 animate-spin text-muted-foreground"
              />
            )}
          </div>
          {mode === "task" && (
            <button
              type="button"
              data-testid="new-task-pr-remove"
              aria-label="Remove pull request"
              title="Don't attach a pull request"
              onClick={onRemove}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      )}
      {lookup?.status === "error" && (
        <span
          data-testid="new-task-pr-error"
          role="alert"
          className="pl-1 text-[11px] text-status-error"
        >
          {lookup.message}
        </span>
      )}
    </div>
  );
}
