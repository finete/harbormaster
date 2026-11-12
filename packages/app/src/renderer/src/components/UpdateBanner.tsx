import { ArrowUpCircle, Check, Copy, X } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import type { UpdateInfo } from "../../../preload/api";

/** Dismissing hides the banner for that version only; a newer release shows again. */
const DISMISSED_KEY = "harbormaster.update.dismissedVersion";

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * "Harbormaster vX is available" strip (release plan, "Build and
 * distribution"). Main's update check (main/update-check.ts) compares the
 * latest GitHub release with the running version; the app is installed and
 * upgraded only through the Homebrew cask, so the banner shows the upgrade
 * command with a copy button instead of downloading anything. Renders
 * nothing when there is no newer release or it was dismissed.
 */
export function UpdateBanner(): JSX.Element | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.harbormaster.app
      .getUpdate()
      .then((latest) => {
        if (alive && latest) setUpdate(latest);
      })
      .catch(() => {});
    const unsubscribe = window.harbormaster.app.onUpdateAvailable((next) => {
      setUpdate(next);
      setCopied(false);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (!update || dismissed === update.version) return null;

  const copy = (): void => {
    void window.harbormaster.app.copyText(update.command).then(() => {
      setCopied(true);
    });
  };
  const dismiss = (): void => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, update.version);
    } catch {}
    setDismissed(update.version);
  };

  return (
    <div
      data-testid="update-banner"
      data-version={update.version}
      className="flex shrink-0 items-center justify-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs text-foreground"
    >
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span>
        Harbormaster v{update.version} is available:{" "}
        <code
          data-testid="update-banner-command"
          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono"
        >
          {update.command}
        </code>
      </span>
      <button
        type="button"
        data-testid="update-banner-copy"
        onClick={copy}
        title="Copy the upgrade command"
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        data-testid="update-banner-dismiss"
        onClick={dismiss}
        title="Dismiss"
        aria-label="Dismiss"
        className="rounded p-0.5 text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
