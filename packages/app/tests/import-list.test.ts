import { describe, expect, it } from "vitest";
import type {
  ImportCandidate,
  ImportCandidateGroup,
  ImportCandidateListing,
  ImportCandidateSession,
} from "../src/preload/api";
import {
  buildSelections,
  EMPTY_CHOICES,
  forkInstead,
  groupState,
  hiddenCount,
  importButtonLabel,
  initialChoices,
  mergeChoices,
  otherSessionsLabel,
  pickSession,
  rowBlock,
  rowLabels,
  selectedCount,
  setTitle,
  titleHint,
  toggleGroup,
  toggleRow,
  visibleGroups,
} from "../src/renderer/src/lib/import-list";

function session(
  id: string,
  extra: Partial<ImportCandidateSession> = {},
): ImportCandidateSession {
  return {
    harness: "pi",
    sessionId: id,
    sessionPath: `/s/${id}.jsonl`,
    lastActiveAt: "2026-11-24T10:00:00.000Z",
    userPrompts: 4,
    canFork: true,
    ...extra,
  };
}

function candidate(
  id: string,
  extra: Partial<ImportCandidate> = {},
): ImportCandidate {
  return {
    id,
    folderPath: `/w/${id}`,
    kind: "worktree",
    groupLabel: "acme/alpha",
    title: `Title ${id}`,
    titleSource: "session",
    sessions: [session(`${id}-a`)],
    defaultSessionId: `${id}-a`,
    sources: ["pi"],
    lastActiveAt: "2026-11-24T10:00:00.000Z",
    preselected: true,
    ...extra,
  };
}

const group = (
  id: string,
  candidates: ImportCandidate[],
): ImportCandidateGroup => ({ id, label: id, candidates });

const listing = (groups: ImportCandidateGroup[]): ImportCandidateListing => ({
  groups,
  sources: [],
  scannedAt: "2026-11-24T10:00:00.000Z",
});

const running = (precision: "session" | "folder" = "folder") => ({
  where: "terminal" as const,
  precision,
  message: "Running in a terminal: close it there, or fork it.",
});

describe("titleHint", () => {
  it("words every title source", () => {
    expect(titleHint("herdr")).toBe("from herdr workspace");
    expect(titleHint("pull-request")).toBe("from PR title");
    expect(titleHint("session")).toBe("from session title");
    expect(titleHint("branch")).toBe("from branch");
    expect(titleHint("folder")).toBe("from folder name");
  });
});

describe("selection", () => {
  const free = candidate("free");
  const merged = candidate("merged", {
    preselected: false,
    pullRequest: { number: 1, url: "u", state: "merged" },
  });
  const onBoard = candidate("onboard", {
    blocked: "on-board",
    preselected: false,
  });
  const busy = candidate("busy", {
    sessions: [session("busy-a", { running: running() })],
    defaultSessionId: "busy-a",
  });
  const all = listing([group("g", [free, merged, onBoard, busy])]);

  it("pre-ticks core's preselected rows, never a blocked or running one", () => {
    expect([...initialChoices(all).selected]).toEqual(["free"]);
  });

  it("does not tick an on-board or running row", () => {
    expect(toggleRow(EMPTY_CHOICES, onBoard).selected.size).toBe(0);
    expect(toggleRow(EMPTY_CHOICES, busy).selected.size).toBe(0);
    expect(toggleRow(EMPTY_CHOICES, merged).selected.has("merged")).toBe(true);
  });

  it("labels merged / closed / already in Harbormaster", () => {
    expect(rowLabels(merged)).toEqual(["merged"]);
    expect(rowLabels(onBoard)).toEqual(["already in Harbormaster"]);
    expect(rowLabels(free)).toEqual([]);
  });

  it("select-all ticks every selectable row, then clears them", () => {
    const g = all.groups[0] as ImportCandidateGroup;
    const ticked = toggleGroup(EMPTY_CHOICES, g);
    expect([...ticked.selected].sort()).toEqual(["free", "merged"]);
    expect(groupState(g, ticked)).toBe("all");
    expect(groupState(g, EMPTY_CHOICES)).toBe("none");
    expect(toggleGroup(ticked, g).selected.size).toBe(0);
    expect(groupState(g, toggleRow(EMPTY_CHOICES, free))).toBe("some");
  });

  it("counts and labels the import button", () => {
    const ticked = toggleGroup(
      EMPTY_CHOICES,
      all.groups[0] as ImportCandidateGroup,
    );
    expect(selectedCount(all, ticked)).toBe(2);
    expect(selectedCount(undefined, ticked)).toBe(0);
    expect(importButtonLabel(0)).toBe("Import");
    expect(importButtonLabel(1)).toBe("Import 1 task");
    expect(importButtonLabel(3)).toBe("Import 3 tasks");
  });
});

describe("sessions and fork", () => {
  const two = candidate("two", {
    sessions: [
      session("two-new", { running: running() }),
      session("two-old", { harness: "claude-code", userPrompts: 9 }),
    ],
    defaultSessionId: "two-new",
  });
  const cursor = candidate("cursor", {
    sessions: [
      session("c1", { harness: "cursor", canFork: false, running: running() }),
    ],
    defaultSessionId: "c1",
  });

  it("says how many other sessions a row has", () => {
    expect(otherSessionsLabel(two)).toBe("+1 other session");
    expect(otherSessionsLabel(candidate("one"))).toBeUndefined();
    expect(
      otherSessionsLabel(
        candidate("three", {
          sessions: [session("a"), session("b"), session("c")],
        }),
      ),
    ).toBe("+2 other sessions");
  });

  it("Fork instead ticks a running row, only where the agent can fork", () => {
    expect(rowBlock(two, EMPTY_CHOICES)).toBe("running");
    const forked = forkInstead(EMPTY_CHOICES, two);
    expect(rowBlock(two, forked)).toBeUndefined();
    expect(forked.selected.has("two")).toBe(true);
    expect(forkInstead(EMPTY_CHOICES, cursor)).toBe(EMPTY_CHOICES);
    expect(rowBlock(cursor, EMPTY_CHOICES)).toBe("running");
  });

  it("picking another session resets the fork and follows that session's state", () => {
    const forked = forkInstead(EMPTY_CHOICES, two);
    const picked = pickSession(forked, two, "two-old");
    expect(picked.forks.has("two")).toBe(false);
    expect(rowBlock(two, picked)).toBeUndefined();
    const selections = buildSelections(listing([group("g", [two])]), picked);
    expect(selections).toEqual([
      { candidateId: "two", sessionId: "two-old", title: "Title two" },
    ]);
  });

  it("builds selections with edited titles, a blank edit falling back, and the fork flag", () => {
    const l = listing([group("g", [two, candidate("x")])]);
    let choices = forkInstead(EMPTY_CHOICES, two);
    choices = setTitle(choices, two, "  Renamed ");
    choices = toggleRow(choices, candidate("x"));
    choices = setTitle(choices, candidate("x"), "   ");
    expect(buildSelections(l, choices)).toEqual([
      {
        candidateId: "two",
        sessionId: "two-new",
        title: "Renamed",
        fork: true,
      },
      { candidateId: "x", sessionId: "x-a", title: "Title x" },
    ]);
  });
});

describe("hidden rows and re-listing", () => {
  const hiddenOne = candidate("h", { hidden: "tiny", preselected: false });
  const shown = candidate("s");
  const groups = [
    group("a", [shown, hiddenOne]),
    group("b", [candidate("h2", { hidden: "folder-missing" })]),
  ];

  it("hides hidden rows (and empty groups) unless asked, and counts them", () => {
    expect(visibleGroups(groups, false).map((g) => g.id)).toEqual(["a"]);
    expect(visibleGroups(groups, false)[0]?.candidates).toHaveLength(1);
    expect(visibleGroups(groups, true)).toHaveLength(2);
    expect(hiddenCount(groups)).toBe(2);
  });

  it("keeps the user's edits across a re-list, ticks only new preselected rows, drops rows that stopped being selectable", () => {
    const before = listing([
      group("a", [candidate("keep"), candidate("busy")]),
    ]);
    let choices = initialChoices(before);
    choices = setTitle(choices, candidate("keep"), "Mine");
    const previousIds = new Set(["keep", "busy"]);
    const after = listing([
      group("a", [
        candidate("keep"),
        candidate("busy", {
          sessions: [session("busy-a", { running: running() })],
          defaultSessionId: "busy-a",
        }),
        candidate("new"),
      ]),
    ]);
    const merged = mergeChoices(choices, previousIds, after);
    expect([...merged.selected].sort()).toEqual(["keep", "new"]);
    expect(merged.titles.keep).toBe("Mine");
  });
});
