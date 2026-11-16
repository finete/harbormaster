// Dockview panel type `url` (docs/plannotator.md decisions 3/6/7): an
// agent-opened loopback page in an iframe. The task's review tab
// (`review:<taskId>`) hosts its Plannotator sessions; when a session ends
// (feedback sent, server gone) the tab stays and shows "Review sent" with
// Review again. Main polls the URL with a HEAD while the tab is open; a
// failed frame load counts as gone too. Before a session's URL arrives the
// tab follows the task's review request (lib/review.ts `reviewWaitState`):
// starting, queued until the agent's turn ends, or "No review session
// appeared" with Try again after 60 s.

import type { IDockviewPanelProps } from "dockview-react";
import { Loader2, MessageSquareCode } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useBoard, usePresenceMap } from "../core-client";
import {
  reviewWaitState,
  startReview,
  taskHarness,
  useReviewRequest,
} from "../lib/review";
import { useNow } from "../lib/use-now";
import { harnessLabel } from "./CodeReviewSettings";
import { Button } from "./ui/button";

export interface UrlPanelParams {
  taskId: string;
  kind: "review" | "preview";
  /** Absent on a review tab whose review was just requested. */
  url?: string | undefined;
}

/** How often an open tab checks its page's server is still there. */
export const URL_PROBE_INTERVAL_MS = 3000;

/** The sandbox decision 7 settles on. */
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

function Placeholder({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** How often a waiting review tab re-checks its 60 s timeout. */
const WAIT_TICK_MS = 1000;

/** The task's agent, from the board (the request records it too). */
function useTaskHarness(taskId: string): string {
  const columns = useBoard();
  return useMemo(() => {
    for (const column of columns) {
      for (const group of column.groups) {
        const task = group.tasks.find((entry) => entry.id === taskId);
        if (task) return taskHarness(task);
      }
    }
    return "pi";
  }, [columns, taskId]);
}

/** A review tab with no session URL yet (see `reviewWaitState`). */
function ReviewWaiting({ taskId }: { taskId: string }): JSX.Element {
  const request = useReviewRequest(taskId);
  const boardHarness = useTaskHarness(taskId);
  const agentWorking = usePresenceMap()[taskId]?.runningTurn === true;
  const now = useNow(WAIT_TICK_MS);
  const [requesting, setRequesting] = useState(false);
  // The timeout counts from the click, or from when a queued review's agent
  // last started or stopped working (it types the command then).
  const [clockFrom, setClockFrom] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new request or a turn change restarts the clock.
  useEffect(() => {
    setClockFrom(Date.now());
  }, [agentWorking, request?.at]);
  const state = reviewWaitState({ request, clockFrom, now, agentWorking });
  const harness = request?.harness ?? boardHarness;

  async function tryAgain(): Promise<void> {
    if (requesting) return;
    setRequesting(true);
    try {
      await startReview(taskId, {
        harness,
        ...(request?.target ? { target: request.target } : {}),
      });
    } finally {
      setRequesting(false);
    }
  }

  if (state === "queued") {
    return (
      <Placeholder testId="url-pane-queued">
        <Loader2 className="h-4 w-4 animate-spin" />
        Review will start when the agent finishes its turn.
      </Placeholder>
    );
  }
  if (state === "starting") {
    return (
      <Placeholder testId="url-pane-starting">
        <Loader2 className="h-4 w-4 animate-spin" />
        Starting review…
      </Placeholder>
    );
  }
  const command = request?.command ?? "/plannotator-review";
  return (
    <Placeholder testId="url-pane-no-session">
      <MessageSquareCode className="h-5 w-5" />
      <p className="text-foreground">No review session appeared</p>
      <ul className="max-w-sm space-y-1 text-xs">
        <li>
          The agent may not have run{" "}
          <span className="font-mono">{command}</span> — check its terminal.
        </li>
        <li>
          Plannotator not set up for {harnessLabel(harness)}? Welcome / Setup…
        </li>
      </ul>
      <Button
        size="sm"
        variant="secondary"
        disabled={requesting}
        onClick={() => void tryAgain()}
        data-testid="review-try-again-button"
      >
        {requesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Try again
      </Button>
    </Placeholder>
  );
}

export function UrlPane(
  props: IDockviewPanelProps<UrlPanelParams>,
): JSX.Element {
  const { taskId, kind, url } = props.params;
  const [ended, setEnded] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const harness = useTaskHarness(taskId);

  // A new session (or a fresh request) replaces the ended state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: url is the reset trigger.
  useEffect(() => {
    setEnded(false);
  }, [url]);

  useEffect(() => {
    if (!url || ended) return;
    let stopped = false;
    const check = (): void => {
      void window.harbormaster.core.probeUrl(url).then((alive) => {
        if (!stopped && !alive) setEnded(true);
      });
    };
    check();
    const timer = setInterval(check, URL_PROBE_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [url, ended]);

  async function reviewAgain(): Promise<void> {
    if (requesting) return;
    setRequesting(true);
    try {
      // Navigates this tab back to its waiting state (the queued open).
      await startReview(taskId, { harness });
    } finally {
      setRequesting(false);
    }
  }

  if (!url) return <ReviewWaiting taskId={taskId} />;

  if (ended) {
    return kind === "review" ? (
      <Placeholder testId="url-pane-ended">
        <MessageSquareCode className="h-5 w-5" />
        <p>Review sent — the agent is working on it</p>
        <Button
          size="sm"
          variant="secondary"
          disabled={requesting}
          onClick={() => void reviewAgain()}
          data-testid="review-again-button"
        >
          {requesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Review again
        </Button>
      </Placeholder>
    ) : (
      <Placeholder testId="url-pane-ended">
        <p>This page is no longer running.</p>
      </Placeholder>
    );
  }

  return (
    <iframe
      key={url}
      src={url}
      title={kind === "review" ? "Review" : url}
      sandbox={SANDBOX}
      className="h-full w-full border-0 bg-background"
      data-testid="url-pane-frame"
      data-url={url}
      onError={() => setEnded(true)}
    />
  );
}
