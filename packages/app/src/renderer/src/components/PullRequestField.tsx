// The new-task composer's "PR URL" row (docs/release-plan.md "Reviewer
// tasks"): bind the task to an existing pull request and say whose it is.
// The URL is parsed by core (`parsePullRequestUrl`); the role label is
// Author (your PR: continue on its head branch) or Reviewer (someone
// else's: check out the head, never push or open a PR); "From GitHub" lets
// core decide from `viewerDidAuthor`. Its own component so the composer's
// toolbar (Where · Agent · Model) stays untouched.
import { GitPullRequest } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  PullRequestReference,
  PullRequestRole,
} from "../../../preload/api";
import { cn } from "../lib/utils";

const ROLES: Array<{ id: PullRequestRole | ""; label: string; hint: string }> =
  [
    {
      id: "",
      label: "From GitHub",
      hint: "Your own PR continues as its author; anyone else's is a review",
    },
    {
      id: "author",
      label: "Author",
      hint: "Continues the PR on its head branch; Await review pushes to it",
    },
    {
      id: "reviewer",
      label: "Reviewer",
      hint: "Checks out the PR head to review it; never pushes or opens a PR",
    },
  ];

/** Core's parse of `url`: `undefined` while parsing, `null` when it is not a PR URL. */
export function useParsedPullRequest(
  url: string,
): PullRequestReference | null | undefined {
  const [parsed, setParsed] = useState<{
    url: string;
    value: PullRequestReference | null;
  } | null>(null);
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    let cancelled = false;
    void window.harbormaster.core
      .parsePullRequestUrl(trimmed)
      .then((value) => {
        if (!cancelled) setParsed({ url: trimmed, value });
      })
      .catch(() => {
        if (!cancelled) setParsed({ url: trimmed, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  const trimmed = url.trim();
  if (!trimmed) return null;
  return parsed?.url === trimmed ? parsed.value : undefined;
}

export function PullRequestField({
  url,
  role,
  parsed,
  onChange,
}: {
  url: string;
  role: PullRequestRole | "";
  parsed: PullRequestReference | null | undefined;
  onChange: (patch: { prUrl?: string; prRole?: PullRequestRole | "" }) => void;
}): JSX.Element {
  const active = ROLES.find((option) => option.id === role) ?? ROLES[0];
  return (
    <div
      className="flex flex-col gap-1.5 px-1 text-[11px] text-muted-foreground"
      data-testid="new-task-pr"
    >
      <div className="flex items-center gap-2">
        <GitPullRequest className="size-3.5 shrink-0" aria-hidden />
        <input
          data-testid="new-task-pr-url-input"
          aria-label="Pull request URL"
          value={url}
          onChange={(event) => onChange({ prUrl: event.target.value })}
          placeholder="PR URL (optional): work on an existing pull request"
          className="h-6 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {url.trim() && (
          <fieldset
            className="m-0 flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
            aria-label="Role"
            data-testid="new-task-pr-role"
          >
            {ROLES.map((option) => (
              <button
                key={option.id || "github"}
                type="button"
                aria-pressed={role === option.id}
                data-testid={`new-task-pr-role-${option.id || "github"}`}
                title={option.hint}
                onClick={() => onChange({ prRole: option.id })}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                  role === option.id
                    ? "bg-accent text-foreground"
                    : "hover:bg-accent/50",
                )}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {url.trim() && (
        <span className="pl-5" data-testid="new-task-pr-hint">
          {parsed === undefined
            ? "Checking…"
            : parsed === null
              ? "Not a pull request URL (…/org/repo/pull/12)"
              : `${parsed.repositoryId} #${parsed.number}: ${active?.hint ?? ""}`}
        </span>
      )}
    </div>
  );
}
