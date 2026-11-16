// Dockview panel type `url` (docs/plannotator.md decisions 3/6/7): an
// agent-opened loopback page in an iframe. The task's review tab
// (`review:<taskId>`) hosts its Plannotator sessions; when a session ends
// (feedback sent, server gone) the tab stays and shows "Review sent" with
// Review again. Main polls the URL with a HEAD while the tab is open; a
// failed frame load counts as gone too.

import type { IDockviewPanelProps } from "dockview-react";
import { Loader2, MessageSquareCode } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";
import { describeThrown, pushToast } from "../toast";
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

export function UrlPane(
  props: IDockviewPanelProps<UrlPanelParams>,
): JSX.Element {
  const { taskId, kind, url } = props.params;
  const [ended, setEnded] = useState(false);
  const [requesting, setRequesting] = useState(false);

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
      await window.harbormaster.core.requestReview({ taskId });
      props.api.updateParameters({ taskId, kind, url: undefined });
    } catch (error) {
      pushToast(`Review failed: ${describeThrown(error)}`);
    } finally {
      setRequesting(false);
    }
  }

  if (!url) {
    return (
      <Placeholder testId="url-pane-starting">
        <Loader2 className="h-4 w-4 animate-spin" />
        Starting review…
      </Placeholder>
    );
  }

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
