// The Setup screen's "Check setup" (next to Export Diagnostics): runs the
// core `doctor` command through main (`window.harbormaster.core.doctor`,
// which adds the app-only facts) and shows the checks grouped, each with a
// status icon, its detail and remediation, plus Re-run. Read-only: nothing
// here changes the setup.

import {
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { JSX } from "react";
import { useCallback, useState } from "react";
import type { DoctorReport, DoctorStatus } from "../../../preload/api";
import { doctorHeadline, groupDoctorChecks } from "../lib/doctor-view";
import { cn } from "../lib/utils";
import { describeThrown } from "../toast";
import { Button } from "./ui/button";

export interface SetupCheckState {
  report: DoctorReport | null;
  running: boolean;
  error: string;
  run: () => void;
}

/** The "Check setup" state: the last report, whether it runs, and `run`. */
export function useSetupCheck(): SetupCheckState {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(() => {
    setRunning(true);
    setError("");
    window.harbormaster.core
      .doctor()
      .then(setReport)
      .catch((cause: unknown) => setError(describeThrown(cause)))
      .finally(() => setRunning(false));
  }, []);
  return { report, running, error, run };
}

function StatusIcon({ status }: { status: DoctorStatus }): JSX.Element {
  const className = "mt-0.5 h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "ok":
      return (
        <CheckCircle2
          aria-label="ok"
          className={cn(className, "text-status-ok")}
        />
      );
    case "warn":
      return (
        <AlertTriangle
          aria-label="warning"
          className={cn(className, "text-status-needsYou")}
        />
      );
    case "fail":
      return (
        <XCircle
          aria-label="failed"
          className={cn(className, "text-status-error")}
        />
      );
    default:
      return (
        <MinusCircle
          aria-label="skipped"
          className={cn(className, "text-muted-foreground")}
        />
      );
  }
}

/** The grouped results (or the error), with Re-run. Renders nothing before the first run. */
export function SetupCheckResults({
  state,
}: {
  state: SetupCheckState;
}): JSX.Element | null {
  const { report, running, error, run } = state;
  if (!report && !error) return null;
  return (
    <div
      data-testid="setup-check"
      data-running={running ? "true" : "false"}
      className="flex flex-col gap-2 rounded-md border border-border px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <p data-testid="setup-check-headline" className="text-xs font-semibold">
          {error
            ? "Could not check the setup"
            : report
              ? doctorHeadline(report)
              : ""}
        </p>
        <Button
          variant="ghost"
          size="sm"
          data-testid="setup-check-rerun"
          disabled={running}
          onClick={run}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", running && "animate-spin")} />
          Re-run
        </Button>
      </div>
      {error && <p className="text-xs text-status-error">{error}</p>}
      {report &&
        groupDoctorChecks(report).map((group) => (
          <div key={group.group} className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title}
            </p>
            {group.checks.map((check) => (
              <div
                key={check.id}
                data-testid={`doctor-check-${check.id}`}
                data-status={check.status}
                className="flex items-start gap-2 text-xs"
              >
                <StatusIcon status={check.status} />
                <div className="min-w-0 flex-1">
                  <p className="[overflow-wrap:anywhere]">
                    <span className="text-muted-foreground">{check.id}</span>{" "}
                    {check.summary}
                  </p>
                  {check.detail && check.status !== "ok" && (
                    <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                      {check.detail}
                    </p>
                  )}
                  {check.remediation &&
                    (check.status === "warn" || check.status === "fail") && (
                      <p className="text-foreground [overflow-wrap:anywhere]">
                        → {check.remediation}
                      </p>
                    )}
                </div>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
