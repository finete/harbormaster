// Pure logic behind the shared ImportList (docs/import.md "UI"): which rows
// are selectable, the per-row choices (ticked, title, picked session, fork),
// select-all per repository, counts and the selections `importItems` takes.
// Free of React and the DOM (tests/import-list.test.ts). Core decides what a
// candidate is; this only shapes the screen.

import type {
  ImportCandidate,
  ImportCandidateGroup,
  ImportCandidateListing,
  ImportCandidateSession,
  ImportItemSelection,
} from "../../../preload/api";

/** What the user changed on the rows (everything else comes from the listing). */
export interface ImportChoices {
  /** Ticked candidate ids. */
  selected: ReadonlySet<string>;
  /** Edited titles, by candidate id (absent = the proposed one). */
  titles: Readonly<Record<string, string>>;
  /** Picked sessions, by candidate id (absent = `defaultSessionId`). */
  sessions: Readonly<Record<string, string>>;
  /** Rows set to "Fork instead". */
  forks: ReadonlySet<string>;
}

export const EMPTY_CHOICES: ImportChoices = {
  selected: new Set(),
  titles: {},
  sessions: {},
  forks: new Set(),
};

/** The grey hint under a title: where core took it from (decision I7). */
export function titleHint(source: ImportCandidate["titleSource"]): string {
  switch (source) {
    case "herdr":
      return "from herdr workspace";
    case "pull-request":
      return "from PR title";
    case "session":
      return "from session title";
    case "branch":
      return "from branch";
    case "folder":
      return "from folder name";
  }
}

/** The session a row is bound to: the picked one, else the default (else the newest). */
export function pickedSession(
  candidate: ImportCandidate,
  choices: Pick<ImportChoices, "sessions">,
): ImportCandidateSession {
  const wanted = choices.sessions[candidate.id] ?? candidate.defaultSessionId;
  const found = candidate.sessions.find(
    (session) => session.sessionId === wanted,
  );
  // Sessions are never empty (core contract).
  return (found ?? candidate.sessions[0]) as ImportCandidateSession;
}

/** Why a row cannot be ticked right now, or undefined when it can. */
export type RowBlock = "on-board" | "running";

export function rowBlock(
  candidate: ImportCandidate,
  choices: ImportChoices,
): RowBlock | undefined {
  if (candidate.blocked === "on-board") return "on-board";
  const session = pickedSession(candidate, choices);
  if (session.running) {
    // A running session can only come in as a fork, and only where the agent can fork.
    return choices.forks.has(candidate.id) && session.canFork
      ? undefined
      : "running";
  }
  return undefined;
}

export function isSelectable(
  candidate: ImportCandidate,
  choices: ImportChoices,
): boolean {
  return rowBlock(candidate, choices) === undefined;
}

/** Whether "Fork instead" is offered: the picked session is running and its agent can fork. */
export function canOfferFork(
  candidate: ImportCandidate,
  choices: Pick<ImportChoices, "sessions">,
): boolean {
  const session = pickedSession(candidate, choices);
  return Boolean(session.running) && session.canFork;
}

/** The row's title: the edit, else core's proposal. */
export function rowTitle(
  candidate: ImportCandidate,
  choices: Pick<ImportChoices, "titles">,
): string {
  return choices.titles[candidate.id] ?? candidate.title;
}

/** "+N other sessions" (singular for one), or undefined for a single-session row. */
export function otherSessionsLabel(
  candidate: ImportCandidate,
): string | undefined {
  const others = candidate.sessions.length - 1;
  if (others <= 0) return undefined;
  return `+${others} other ${others === 1 ? "session" : "sessions"}`;
}

/** The status labels a row carries next to its title. */
export function rowLabels(candidate: ImportCandidate): string[] {
  const labels: string[] = [];
  const state = candidate.pullRequest?.state;
  if (state === "merged" || state === "closed") labels.push(state);
  if (candidate.blocked === "on-board") labels.push("already in Harbormaster");
  return labels;
}

/** Candidates in `groups` that show: hidden ones only with `showHidden`. Empty groups drop out. */
export function visibleGroups(
  groups: readonly ImportCandidateGroup[],
  showHidden: boolean,
): ImportCandidateGroup[] {
  return groups
    .map((group) => ({
      ...group,
      candidates: group.candidates.filter(
        (candidate) => showHidden || !candidate.hidden,
      ),
    }))
    .filter((group) => group.candidates.length > 0);
}

/** How many candidates "Show hidden (n)" would reveal (`on-board` ones are not offered anyway). */
export function hiddenCount(groups: readonly ImportCandidateGroup[]): number {
  let count = 0;
  for (const group of groups) {
    for (const candidate of group.candidates) {
      if (candidate.hidden && candidate.blocked !== "on-board") count += 1;
    }
  }
  return count;
}

/** Starting choices for a fresh listing: core's `preselected` rows that are selectable. */
export function initialChoices(listing: ImportCandidateListing): ImportChoices {
  const selected = new Set<string>();
  for (const group of listing.groups) {
    for (const candidate of group.candidates) {
      if (candidate.preselected && isSelectable(candidate, EMPTY_CHOICES)) {
        selected.add(candidate.id);
      }
    }
  }
  return { ...EMPTY_CHOICES, selected };
}

/**
 * Choices after a re-list (Check again, Show older…): what the user did on
 * rows that are still there survives; rows that are new take core's
 * preselection; ticks on rows that stopped being selectable are dropped.
 */
export function mergeChoices(
  previous: ImportChoices,
  previousIds: ReadonlySet<string>,
  listing: ImportCandidateListing,
): ImportChoices {
  const fresh = initialChoices(listing);
  const selected = new Set<string>();
  const titles: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  const forks = new Set<string>();
  for (const group of listing.groups) {
    for (const candidate of group.candidates) {
      const id = candidate.id;
      if (!previousIds.has(id)) {
        if (fresh.selected.has(id)) selected.add(id);
        continue;
      }
      const title = previous.titles[id];
      if (title !== undefined) titles[id] = title;
      const session = previous.sessions[id];
      if (
        session !== undefined &&
        candidate.sessions.some((entry) => entry.sessionId === session)
      ) {
        sessions[id] = session;
      }
      if (previous.forks.has(id)) forks.add(id);
      if (previous.selected.has(id)) selected.add(id);
    }
  }
  const merged: ImportChoices = { selected, titles, sessions, forks };
  const kept = new Set<string>();
  for (const group of listing.groups) {
    for (const candidate of group.candidates) {
      if (selected.has(candidate.id) && isSelectable(candidate, merged)) {
        kept.add(candidate.id);
      }
    }
  }
  return { ...merged, selected: kept };
}

export function toggleRow(
  choices: ImportChoices,
  candidate: ImportCandidate,
): ImportChoices {
  const selected = new Set(choices.selected);
  if (selected.has(candidate.id)) {
    selected.delete(candidate.id);
  } else if (isSelectable(candidate, choices)) {
    selected.add(candidate.id);
  }
  return { ...choices, selected };
}

/** The group's select-all state: every selectable row ticked, none, or some. */
export function groupState(
  group: ImportCandidateGroup,
  choices: ImportChoices,
): "all" | "none" | "some" | "empty" {
  const selectable = group.candidates.filter((candidate) =>
    isSelectable(candidate, choices),
  );
  if (selectable.length === 0) return "empty";
  const ticked = selectable.filter((candidate) =>
    choices.selected.has(candidate.id),
  ).length;
  if (ticked === 0) return "none";
  return ticked === selectable.length ? "all" : "some";
}

/** Select-all: when every selectable row is ticked it clears them, else ticks them all. */
export function toggleGroup(
  choices: ImportChoices,
  group: ImportCandidateGroup,
): ImportChoices {
  const selectable = group.candidates.filter((candidate) =>
    isSelectable(candidate, choices),
  );
  const selected = new Set(choices.selected);
  const allOn =
    selectable.length > 0 &&
    selectable.every((candidate) => selected.has(candidate.id));
  for (const candidate of selectable) {
    if (allOn) selected.delete(candidate.id);
    else selected.add(candidate.id);
  }
  return { ...choices, selected };
}

/** Pick another session for a row: a fork choice belongs to the session it was made for, so it resets. */
export function pickSession(
  choices: ImportChoices,
  candidate: ImportCandidate,
  sessionId: string,
): ImportChoices {
  const sessions = { ...choices.sessions, [candidate.id]: sessionId };
  const forks = new Set(choices.forks);
  forks.delete(candidate.id);
  const next: ImportChoices = { ...choices, sessions, forks };
  const selected = new Set(next.selected);
  // The new session may be running (can't stay ticked) or free (stays as the user left it).
  if (!isSelectable(candidate, next)) selected.delete(candidate.id);
  return { ...next, selected };
}

/** "Fork instead" on a running row: bind a fork of the session, and tick the row. */
export function forkInstead(
  choices: ImportChoices,
  candidate: ImportCandidate,
): ImportChoices {
  if (!canOfferFork(candidate, choices)) return choices;
  const forks = new Set(choices.forks);
  forks.add(candidate.id);
  const selected = new Set(choices.selected);
  selected.add(candidate.id);
  return { ...choices, forks, selected };
}

/** Back out of "Fork instead": the row is a plain running row again. */
export function cancelFork(
  choices: ImportChoices,
  candidate: ImportCandidate,
): ImportChoices {
  const forks = new Set(choices.forks);
  forks.delete(candidate.id);
  const selected = new Set(choices.selected);
  selected.delete(candidate.id);
  return { ...choices, forks, selected };
}

export function setTitle(
  choices: ImportChoices,
  candidate: ImportCandidate,
  title: string,
): ImportChoices {
  return { ...choices, titles: { ...choices.titles, [candidate.id]: title } };
}

/** Ticked rows, in listing order, restricted to rows that are still there and selectable. */
export function selectedCandidates(
  listing: ImportCandidateListing | undefined,
  choices: ImportChoices,
): ImportCandidate[] {
  if (!listing) return [];
  return listing.groups
    .flatMap((group) => group.candidates)
    .filter(
      (candidate) =>
        choices.selected.has(candidate.id) && isSelectable(candidate, choices),
    );
}

export function selectedCount(
  listing: ImportCandidateListing | undefined,
  choices: ImportChoices,
): number {
  return selectedCandidates(listing, choices).length;
}

/** "Import 3 tasks" / "Import 1 task" / "Import" with nothing ticked. */
export function importButtonLabel(count: number): string {
  if (count <= 0) return "Import";
  return `Import ${count} ${count === 1 ? "task" : "tasks"}`;
}

/** What `importItems` takes. A blank edited title falls back to the proposal. */
export function buildSelections(
  listing: ImportCandidateListing | undefined,
  choices: ImportChoices,
): ImportItemSelection[] {
  return selectedCandidates(listing, choices).map((candidate) => {
    const title = rowTitle(candidate, choices).trim();
    return {
      candidateId: candidate.id,
      sessionId: pickedSession(candidate, choices).sessionId,
      title: title || candidate.title,
      ...(choices.forks.has(candidate.id) ? { fork: true } : {}),
    };
  });
}

/** A source that could not be read fully, as the quiet footnote words it. */
export function sourceFootnote(
  sources: ImportCandidateListing["sources"],
): string | undefined {
  const broken = sources.filter((source) => source.error);
  if (broken.length === 0) return undefined;
  return broken.map((source) => `${source.label}: ${source.error}`).join(" · ");
}
