// Text shaping for the import tools (docs/import.md "CLI / MCP"). Pure: the
// catalog handlers fetch from the core commands, these functions only turn
// the contract types into the text an agent or a terminal reads. No import
// rules live here; "dry run" only restates what the listing already says.

import type {
  ImportBlockReason,
  ImportCandidate,
  ImportCandidateListing,
  ImportCandidateSession,
  ImportHiddenReason,
  ImportItemSelection,
  ImportItemsResult,
  ImportSkipReason,
  ImportTitleSource,
  UndoImportResult,
} from "../contracts/import.js";

const HIDDEN_LABEL: Record<ImportHiddenReason, string> = {
  tiny: "tiny",
  "folder-missing": "folder missing",
  "not-a-project": "not a project",
  "harbormaster-leftover": "Harbormaster leftover",
};

const SKIP_LABEL: Record<ImportSkipReason, string> = {
  running: "running elsewhere",
  "on-board": "already in Harbormaster",
  "folder-missing": "folder missing",
  "session-missing": "session missing",
  "cannot-fork": "cannot fork",
  error: "error",
};

/** How long ago `iso` was relative to `now` ("today", "3d ago", "2mo ago"). */
export function formatAge(iso: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function sourceLabel(
  listing: Pick<ImportCandidateListing, "sources">,
  id: string,
): string {
  return listing.sources.find((source) => source.id === id)?.label ?? id;
}

function titleHint(
  listing: Pick<ImportCandidateListing, "sources">,
  candidate: ImportCandidate,
): string {
  const defaultSession = candidate.sessions.find(
    (session) => session.sessionId === candidate.defaultSessionId,
  );
  const hints: Record<ImportTitleSource, string> = {
    herdr: "herdr workspace name",
    "pull-request": "PR title",
    session: `${defaultSession ? sourceLabel(listing, defaultSession.harness) : "agent"} session title`,
    branch: "branch",
    folder: "folder name",
  };
  return `(from ${hints[candidate.titleSource]})`;
}

function runningSession(
  candidate: ImportCandidate,
): ImportCandidateSession | undefined {
  const picked = candidate.sessions.find(
    (session) => session.sessionId === candidate.defaultSessionId,
  );
  return picked?.running
    ? picked
    : candidate.sessions.find((session) => session.running);
}

function canFork(candidate: ImportCandidate): boolean {
  return candidate.sessions.some((session) => session.canFork);
}

function blockedLine(candidate: ImportCandidate): string | undefined {
  const reason: ImportBlockReason | undefined = candidate.blocked;
  if (reason === "on-board") {
    return `already in Harbormaster${candidate.onBoardTaskId ? ` (task ${candidate.onBoardTaskId})` : ""}`;
  }
  if (reason === "running") {
    const running = runningSession(candidate)?.running;
    const message = running?.message ?? "running elsewhere";
    return `${message} ${
      canFork(candidate)
        ? `Fork is possible: import it with --fork ${candidate.id}.`
        : "This agent cannot fork: close it there and list again."
    }`;
  }
  return undefined;
}

function prLabel(candidate: ImportCandidate): string | undefined {
  const pr = candidate.pullRequest;
  if (!pr) return undefined;
  return `PR #${pr.number}${pr.state === "merged" || pr.state === "closed" ? ` ${pr.state}` : ""}`;
}

function candidateLines(
  listing: ImportCandidateListing,
  candidate: ImportCandidate,
): string[] {
  const marker = candidate.blocked
    ? "[-]"
    : candidate.preselected
      ? "[x]"
      : "[ ]";
  const details = [
    candidate.kind,
    candidate.branch ? `branch ${candidate.branch}` : undefined,
    prLabel(candidate),
    `last active ${formatAge(candidate.lastActiveAt, listing.scannedAt)}`,
    candidate.sessions.length > 1
      ? `+${candidate.sessions.length - 1} other session${candidate.sessions.length === 2 ? "" : "s"}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const lines = [
    `  ${marker} ${candidate.id}  ${candidate.title} ${titleHint(listing, candidate)}`,
    `        ${details.join(" · ")}`,
  ];
  const blocked = blockedLine(candidate);
  if (blocked) lines.push(`        blocked: ${blocked}`);
  if (candidate.hidden) {
    lines.push(`        hidden: ${HIDDEN_LABEL[candidate.hidden]}`);
  }
  return lines;
}

export interface ImportListFormatOptions {
  includeHidden?: boolean;
}

/** `import_list` text: groups by repository, newest first, blocked/hidden reasons, footnotes. */
export function formatImportListText(
  listing: ImportCandidateListing,
  options: ImportListFormatOptions = {},
): string {
  const lines: string[] = [];
  const hiddenCounts = new Map<ImportHiddenReason, number>();
  let shown = 0;
  for (const group of listing.groups) {
    const visible = group.candidates.filter((candidate) => {
      if (!candidate.hidden || options.includeHidden) return true;
      hiddenCounts.set(
        candidate.hidden,
        (hiddenCounts.get(candidate.hidden) ?? 0) + 1,
      );
      return false;
    });
    if (visible.length === 0) continue;
    shown += visible.length;
    if (lines.length > 0) lines.push("");
    lines.push(`${group.label} (${visible.length})`);
    for (const candidate of visible) {
      lines.push(...candidateLines(listing, candidate));
    }
  }
  if (shown === 0) lines.push("No importable work found.");
  else {
    lines.push(
      "",
      "[x] pre-ticked (--preselected picks these), [ ] selectable, [-] blocked.",
    );
  }
  const hiddenTotal = [...hiddenCounts.values()].reduce((a, b) => a + b, 0);
  if (hiddenTotal > 0) {
    const parts = [...hiddenCounts].map(
      ([reason, count]) => `${HIDDEN_LABEL[reason]} ${count}`,
    );
    lines.push(`${hiddenTotal} hidden: ${parts.join(", ")} (--hidden to show)`);
  }
  for (const source of listing.sources) {
    if (source.error) {
      lines.push(
        `Note: ${source.label} could not be fully read: ${source.error}`,
      );
    }
  }
  return lines.join("\n");
}

/** A selection that `apply` resolved, with the candidate it came from. */
export interface ResolvedImportSelection {
  selection: ImportItemSelection;
  candidate: ImportCandidate;
}

function sessionOf(
  candidate: ImportCandidate,
  sessionId: string,
): ImportCandidateSession | undefined {
  return candidate.sessions.find((session) => session.sessionId === sessionId);
}

/** What `--dry-run` prints: what would be created and what would be left out (no import happens). */
export function formatImportDryRunText(
  listing: ImportCandidateListing,
  resolved: readonly ResolvedImportSelection[],
): string {
  const lines: string[] = [];
  const create = resolved.filter(({ candidate }) => !candidate.blocked);
  const forkable = (r: ResolvedImportSelection): boolean =>
    sessionOf(r.candidate, r.selection.sessionId)?.canFork ?? false;
  const wouldSkip = resolved.filter(
    (r) =>
      r.candidate.blocked === "on-board" ||
      (r.candidate.blocked === "running" && !(r.selection.fork && forkable(r))),
  );
  const creating = create.filter((r) => !wouldSkip.includes(r));
  const forkRunning = resolved.filter(
    (r) => r.candidate.blocked === "running" && r.selection.fork && forkable(r),
  );
  const all = [...creating, ...forkRunning];
  lines.push(
    `Dry run: would import ${all.length} task${all.length === 1 ? "" : "s"}.`,
  );
  for (const { candidate, selection } of all) {
    const session = sessionOf(candidate, selection.sessionId);
    const harness = session ? sourceLabel(listing, session.harness) : "agent";
    lines.push(
      `  + ${candidate.id}  ${selection.title} (${candidate.kind}, ${harness}${selection.fork ? ", fork of the session" : ""})`,
    );
  }
  if (wouldSkip.length > 0) {
    lines.push("Would be left out:");
    for (const { candidate } of wouldSkip) {
      lines.push(
        `  - ${candidate.id}  ${candidate.title}: ${blockedLine(candidate)}`,
      );
    }
  }
  lines.push("Nothing was imported (--dry-run).");
  return lines.join("\n");
}

function formatLeftOut(
  leftOut: Partial<Record<ImportSkipReason, number>>,
): string | undefined {
  const parts = (Object.entries(leftOut) as [ImportSkipReason, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${SKIP_LABEL[reason]}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** `import_apply` result text. `titles` maps candidate id → the title that was sent. */
export function formatImportResultText(
  result: ImportItemsResult,
  titles: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  const n = result.imported.length;
  lines.push(`Imported ${n} task${n === 1 ? "" : "s"}.`);
  for (const item of result.imported) {
    lines.push(
      `  + ${titles.get(item.candidateId) ?? item.candidateId} → task ${item.taskId}`,
    );
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length}:`);
    for (const item of result.skipped) {
      lines.push(
        `  - ${titles.get(item.candidateId) ?? item.candidateId} (${item.candidateId}): ${SKIP_LABEL[item.reason]}${item.detail ? `: ${item.detail}` : ""}`,
      );
    }
  }
  const leftOut = formatLeftOut(result.leftOut);
  if (leftOut) lines.push(`Left out: ${leftOut}.`);
  if (result.batchId) {
    lines.push(
      `Batch: ${result.batchId}`,
      `Undo with: harbormaster import undo ${result.batchId}`,
    );
  }
  return lines.join("\n");
}

/** `import_undo` result text: removed and kept tasks. */
export function formatUndoImportText(result: UndoImportResult): string {
  const lines = [
    `Undid import ${result.batchId}: removed ${result.removed.length} task${result.removed.length === 1 ? "" : "s"}.`,
  ];
  for (const id of result.removed) lines.push(`  - removed task ${id}`);
  if (result.kept.length > 0) {
    lines.push(
      `Kept ${result.kept.length} (opened or changed since the import):`,
    );
    for (const task of result.kept) {
      lines.push(`  = kept task ${task.taskId}: ${task.title}`);
    }
  }
  if (result.removed.length === 0 && result.kept.length === 0) {
    lines.push("Nothing to undo (already undone, or an unknown batch).");
  }
  return lines.join("\n");
}
