// "Code review" settings (docs/plannotator.md decision 5): one row per
// harness from core's `reviewSupport()` with its state (ready ✓ / missing →
// install command / outdated → upgrade command, per piece, copyable), the
// `captureAgentBrowser` switch, and, when given the default agent, a
// one-line summary for it on top. Re-checked whenever the window regains
// focus (the user just ran a fix command in a terminal) and on Recheck.
// Self-contained: rendered on the onboarding Code review step today, liftable
// into a Settings screen as is.

import { Check, Copy, RefreshCw } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  ReviewSupportHarness,
  ReviewSupportPiece,
} from "../../../preload/api";
import {
  harnessSupport,
  recheckReviewSupport,
  useReviewSupport,
} from "../lib/review";
import { cn } from "../lib/utils";
import { describeThrown, pushToast } from "../toast";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

const HARNESS_LABELS: Record<string, string> = {
  pi: "Pi",
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? id;
}

const STATE_TEXT: Record<ReviewSupportHarness["state"], string> = {
  ready: "Ready",
  missing: "Not installed",
  outdated: "Needs an update",
  unsupported: "No review command",
};

function stateClass(state: ReviewSupportHarness["state"]): string {
  return state === "ready"
    ? "text-status-ok"
    : state === "unsupported"
      ? "text-muted-foreground"
      : "text-status-needsYou";
}

function FixCommand({ piece }: { piece: ReviewSupportPiece }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="flex items-start gap-2 text-xs text-muted-foreground"
      data-testid={`code-review-fix-${piece.id}`}
    >
      <span className="shrink-0 pt-0.5">
        {piece.label}{" "}
        {piece.state === "missing"
          ? "missing"
          : `${piece.installed ?? "?"} < ${piece.minimum}`}
        :
      </span>
      <code className="min-w-0 flex-1 select-all break-all rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">
        {piece.fix}
      </code>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 shrink-0 p-0"
        aria-label="Copy command"
        title="Copy command"
        data-testid={`code-review-copy-${piece.id}`}
        onClick={() => {
          void window.harbormaster.app.copyText(piece.fix).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function HarnessRow({ entry }: { entry: ReviewSupportHarness }): JSX.Element {
  const broken = entry.pieces.filter((piece) => piece.state !== "ready");
  return (
    <div
      className="flex flex-col gap-1 py-1.5"
      data-testid={`code-review-row-${entry.harness}`}
      data-state={entry.state}
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {entry.label ?? harnessLabel(entry.harness)}
        </span>
        <span
          className={cn(
            "flex items-center gap-1 text-xs",
            stateClass(entry.state),
          )}
          data-testid={`code-review-state-${entry.harness}`}
        >
          {entry.state === "ready" && <Check className="h-3 w-3" />}
          {STATE_TEXT[entry.state]}
        </span>
      </div>
      {broken.map((piece) => (
        <FixCommand key={piece.id} piece={piece} />
      ))}
    </div>
  );
}

export function CodeReviewSettings({
  defaultHarness,
}: {
  /** Summarized on one line on top (the agent chosen on the onboarding Agent step). */
  defaultHarness?: string;
}): JSX.Element {
  const support = useReviewSupport();
  const [capture, setCapture] = useState<boolean | null>(null);
  useEffect(() => {
    void window.harbormaster.core
      .getLaunchSettings()
      .then((settings) => setCapture(settings.captureAgentBrowser === true))
      .catch(() => setCapture(false));
  }, []);

  function changeCapture(next: boolean): void {
    setCapture(next);
    window.harbormaster.core.setCaptureAgentBrowser(next).catch((error) => {
      setCapture(!next);
      pushToast(`Saving the setting failed: ${describeThrown(error)}`);
    });
  }

  const summary = defaultHarness
    ? harnessSupport(support, defaultHarness)
    : undefined;
  const defaultLabel = defaultHarness
    ? (summary?.label ?? harnessLabel(defaultHarness))
    : "";

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      data-testid="code-review-settings"
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Plannotator review</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          data-testid="code-review-recheck"
          onClick={recheckReviewSupport}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Recheck
        </Button>
      </div>
      {defaultHarness && (
        <p
          className={cn(
            "text-xs",
            summary ? stateClass(summary.state) : "text-muted-foreground",
          )}
          data-testid="code-review-summary"
          data-state={summary?.state ?? "checking"}
        >
          {!support
            ? "Checking Plannotator…"
            : !summary || summary.state === "unsupported"
              ? `${defaultLabel} cannot start a Plannotator review.`
              : summary.state === "ready"
                ? `Plannotator review is ready for ${defaultLabel} ✓`
                : summary.state === "missing"
                  ? `Plannotator is not set up for ${defaultLabel}: install it below to review an agent's changes in the app.`
                  : `Plannotator needs an update for ${defaultLabel}: see below.`}
        </p>
      )}
      <div className="flex flex-col divide-y divide-border">
        {!support ? (
          <p className="py-1.5 text-xs text-muted-foreground">Checking…</p>
        ) : (
          support.harnesses.map((entry) => (
            <HarnessRow key={entry.harness} entry={entry} />
          ))
        )}
      </div>
      <div className="flex items-start gap-3 border-t border-border pt-2">
        <Switch
          checked={capture === true}
          disabled={capture === null}
          onChange={changeCapture}
          testId="code-review-capture-browser"
          label="Open agents' local pages in the app"
        />
        <div className="text-sm">
          <p className="font-medium">Open agents' local pages in the app</p>
          <p className="text-xs text-muted-foreground">
            Also catch every browser open from an agent (dev servers,{" "}
            <code>gh pr view --web</code>…): local pages open as a tab in the
            task, anything else in your browser. Plannotator reviews always open
            in the app. Applies to sessions started from now on.
          </p>
        </div>
      </div>
    </div>
  );
}
