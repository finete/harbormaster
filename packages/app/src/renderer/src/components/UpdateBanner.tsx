import { ArrowUpCircle, Check, Copy, RotateCw, X } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import type { InstalledUpdate, UpdateInfo } from "../../../preload/api";

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
 *
 * Once the app on disk has been replaced (the upgrade ran), the same card
 * offers a restart instead: this window keeps working, but this process
 * can no longer load a new one.
 */
export function UpdateBanner(): JSX.Element | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installed, setInstalled] = useState<InstalledUpdate | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [installedDismissed, setInstalledDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.harbormaster.app
      .getUpdate()
      .then((latest) => {
        if (alive && latest) setUpdate(latest);
      })
      .catch(() => {});
    void window.harbormaster.app
      .getInstalledUpdate()
      .then((next) => {
        if (alive && next) setInstalled(next);
      })
      .catch(() => {});
    const unsubscribe = window.harbormaster.app.onUpdateAvailable((next) => {
      setUpdate(next);
      setCopied(false);
    });
    const unsubscribeInstalled = window.harbormaster.app.onInstalledUpdate(
      (next) => setInstalled(next),
    );
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeInstalled();
    };
  }, []);

  if (installed) {
    if (installedDismissed) return null;
    return (
      <RestartCard
        installed={installed}
        onDismiss={() => setInstalledDismissed(true)}
      />
    );
  }
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

function RestartCard({
  installed,
  onDismiss,
}: {
  installed: InstalledUpdate;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div
      data-testid="restart-banner"
      data-version={installed.version ?? ""}
      role="status"
      className="pointer-events-auto w-80 self-end rounded-lg border border-border bg-card p-3 text-sm text-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Restart to finish updating</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {installed.version
              ? `Harbormaster v${installed.version} is installed; this window is still v${installed.runningVersion}.`
              : `A new Harbormaster is installed; this window is still v${installed.runningVersion}.`}{" "}
            Restarting stops running agents.
          </p>
        </div>
        <button
          type="button"
          data-testid="restart-banner-dismiss"
          onClick={onDismiss}
          title="Close"
          aria-label="Close"
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          data-testid="restart-banner-restart"
          onClick={() => void window.harbormaster.app.restartToUpdate()}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors duration-[120ms] ease-out hover:bg-primary/90"
        >
          <RotateCw className="h-3.5 w-3.5" />
          Restart
        </button>
      </div>
    </div>
  );
}
