// The board's "Automation paused" strip (docs/settings.md S13): shown while
// `automation` is false, following config.json live (a Rules page switch,
// a Settings write or a hand edit all arrive as `config-changed`). The
// switch itself stays on the Rules page; the strip offers "Turn on" (the
// same `setRulesEnabled` command) and a way there.

import { PauseCircle } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import { useConfigValues } from "../lib/config-values";
import { describeThrown, pushToast } from "../toast";
import { Button } from "./ui/button";

/** Whether the board shows the paused strip: only once settings say `automation: false`. */
export function automationPaused(
  values: Record<string, unknown> | undefined,
): boolean {
  return values?.automation === false;
}

export function AutomationPausedBanner({
  onOpenRules,
}: {
  onOpenRules(): void;
}): JSX.Element | null {
  const config = useConfigValues();
  const [busy, setBusy] = useState(false);
  if (!automationPaused(config?.values)) return null;
  return (
    <div
      role="status"
      data-testid="automation-paused-banner"
      className="flex shrink-0 items-center gap-2 border-b border-status-needsYou/40 bg-status-needsYou/10 px-3 py-1 text-xs"
    >
      <PauseCircle className="h-3.5 w-3.5 shrink-0 text-status-needsYou" />
      <span>
        <span className="font-medium">Automation paused</span>
        <span className="text-muted-foreground"> · Rules won't move cards</span>
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          className="h-6 px-2 text-xs"
          data-testid="automation-paused-turn-on"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            window.harbormaster.core
              .setRulesEnabled(true)
              .catch((error: unknown) =>
                pushToast(
                  `Turning automation on failed: ${describeThrown(error)}`,
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          Turn on
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          data-testid="automation-paused-open-rules"
          onClick={onOpenRules}
        >
          Open Rules
        </Button>
      </div>
    </div>
  );
}
