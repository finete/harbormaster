// Pure view helpers for the Setup screen's "Check setup" (components/
// SetupCheck.tsx): the core `doctor` report, grouped for display. Core
// already returns the checks in display order; this only folds consecutive
// checks into titled groups (core's engine is Node-side, so the few titles
// are mirrored here, falling back to the raw group id).

import type { DoctorCheck, DoctorReport } from "../../../preload/api";

const GROUP_TITLES: Record<string, string> = {
  tools: "Tools",
  agents: "Agents",
  state: "State files",
  repos: "Repositories",
  worktrees: "Worktrees",
  disk: "Disk",
  socket: "Tool socket",
  path: "PATH",
};

export interface DoctorGroupView {
  group: string;
  title: string;
  checks: DoctorCheck[];
}

/** The report's checks folded into consecutive groups, in report order. */
export function groupDoctorChecks(report: DoctorReport): DoctorGroupView[] {
  const groups: DoctorGroupView[] = [];
  for (const check of report.checks) {
    const last = groups[groups.length - 1];
    if (last && last.group === check.group) {
      last.checks.push(check);
      continue;
    }
    groups.push({
      group: check.group,
      title: GROUP_TITLES[check.group] ?? check.group,
      checks: [check],
    });
  }
  return groups;
}

/** One line for the result header: `2 failed, 1 warning` or `All checks passed`. */
export function doctorHeadline(report: DoctorReport): string {
  const fail = report.checks.filter((check) => check.status === "fail").length;
  const warn = report.checks.filter((check) => check.status === "warn").length;
  if (fail === 0 && warn === 0) return "All checks passed";
  return [
    fail > 0 ? `${fail} failed` : "",
    warn > 0 ? `${warn} warning${warn === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
