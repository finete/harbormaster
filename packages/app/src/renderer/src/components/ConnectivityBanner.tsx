import { CheckCircle2, Loader2, WifiOff } from "lucide-react";
import type { JSX } from "react";
import { useConnectivity } from "../core-client";
import { cn } from "../lib/utils";

/**
 * One sticky, neutral banner for the offline/reconnecting/restored
 * environmental state (see `useConnectivity`) — never a per-task warning
 * toast. Industry-consensus offline-state pattern (Material offline
 * states, browser "you are offline" strips): a single calm notice instead
 * of a wall of red/amber error toasts, auto-clearing itself on recovery.
 * Renders nothing in the common, healthy case.
 */
export function ConnectivityBanner(): JSX.Element | null {
  const state = useConnectivity();
  if (state === "hidden") return null;

  const label =
    state === "offline"
      ? "Offline — board updates paused"
      : state === "reconnecting"
        ? "Reconnecting…"
        : "Connection restored";

  return (
    <div
      data-testid="connectivity-banner"
      data-state={state}
      className={cn(
        "flex shrink-0 items-center justify-center gap-2 border-b px-3 py-1.5 text-xs font-medium",
        // Neutral grey ramp, deliberately not amber/red: this is an
        // environmental state, not an error; "restored" reads as status ok.
        state === "restored"
          ? "border-status-ok/30 bg-status-ok/10 text-status-ok"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {state === "reconnecting" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === "restored" ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <WifiOff className="h-3.5 w-3.5" />
      )}
      <span>{label}</span>
    </div>
  );
}
