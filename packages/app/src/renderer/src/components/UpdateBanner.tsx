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
 * "New version available" card (release plan, "Build and distribution"),
 * floating bottom-right above the toast stack like Cursor's. Main's update
 * check (main/update-check.ts) compares the latest GitHub release with the
 * running version; the app is installed and upgraded only through the
 * Homebrew cask, so the card shows the upgrade command with a copy button
 * instead of downloading anything. Closing it hides it for that version
 * only; a newer release shows again. Renders nothing otherwise.
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
      role="status"
      className="pointer-events-auto w-80 self-end rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">New version available</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Harbormaster v{update.version} is available. Upgrade, then restart
            the app:
          </p>
        </div>
        <button
          type="button"
          data-testid="update-banner-dismiss"
          onClick={dismiss}
          title="Close"
          aria-label="Close"
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <code
          data-testid="update-banner-command"
          className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs"
          title={update.command}
        >
          {update.command}
        </code>
        <button
          type="button"
          data-testid="update-banner-copy"
          onClick={copy}
          title="Copy the upgrade command"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
