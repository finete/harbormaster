// State of one ImportList (docs/import.md "UI"): the listing from core, the
// user's per-row choices, and the verbs (re-list, import). The Import…
// dialog and the wizard step each own one; both render the same
// `ImportList` from it. Everything goes through the IPC bridge to core's
// commands; nothing here reads an agent store.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ImportCandidate,
  ImportCandidateGroup,
  ImportCandidateListing,
  ImportItemsResult,
} from "../../../preload/api";
import { describeThrown } from "../toast";
import {
  buildSelections,
  cancelFork,
  EMPTY_CHOICES,
  forkInstead,
  type ImportChoices,
  initialChoices,
  mergeChoices,
  pickSession,
  selectedCount,
  setTitle,
  toggleGroup,
  toggleRow,
} from "./import-list";

export interface ImportListModel {
  listing: ImportCandidateListing | undefined;
  /** A (re-)listing is in flight. */
  loading: boolean;
  /** The listing command itself failed. */
  error: string | undefined;
  choices: ImportChoices;
  includeOlder: boolean;
  showHidden: boolean;
  importing: boolean;
  /** Ticked, selectable rows. */
  count: number;
  setIncludeOlder(value: boolean): void;
  setShowHidden(value: boolean): void;
  /** Re-list (Check again, Show older). */
  refresh(): void;
  toggle(candidate: ImportCandidate): void;
  /** Select-all of a (visible) group. */
  toggleGroupOf(group: ImportCandidateGroup): void;
  rename(candidate: ImportCandidate, title: string): void;
  pick(candidate: ImportCandidate, sessionId: string): void;
  fork(candidate: ImportCandidate): void;
  unfork(candidate: ImportCandidate): void;
  /** Import the ticked rows; resolves the result, or undefined when nothing was imported (an error toast is the caller's). */
  importSelected(): Promise<ImportItemsResult | undefined>;
}

/** `enabled: false` waits (the wizard lists only once its step is reached). */
export function useImportList(enabled = true): ImportListModel {
  const [listing, setListing] = useState<ImportCandidateListing>();
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string>();
  const [choices, setChoices] = useState<ImportChoices>(EMPTY_CHOICES);
  const [includeOlder, setIncludeOlderState] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const request = useRef(0);
  const listingRef = useRef<ImportCandidateListing>();
  const choicesRef = useRef(choices);
  choicesRef.current = choices;

  const load = useCallback(async (older: boolean): Promise<void> => {
    const mine = ++request.current;
    setLoading(true);
    try {
      const next = await window.harbormaster.core.listImportCandidates(
        older ? { includeOlder: true } : undefined,
      );
      if (mine !== request.current) return;
      const previous = listingRef.current;
      if (previous) {
        const ids = new Set(
          previous.groups.flatMap((group) => group.candidates.map((c) => c.id)),
        );
        setChoices(mergeChoices(choicesRef.current, ids, next));
      } else {
        setChoices(initialChoices(next));
      }
      listingRef.current = next;
      setListing(next);
      setError(undefined);
    } catch (thrown) {
      if (mine !== request.current) return;
      setError(describeThrown(thrown));
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }, []);

  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first listing only; later ones are explicit verbs.
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void load(false);
  }, [enabled]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const count = useMemo(
    () => selectedCount(listing, choices),
    [listing, choices],
  );

  const setIncludeOlder = useCallback(
    (value: boolean) => {
      setIncludeOlderState(value);
      void load(value);
    },
    [load],
  );

  const importSelected = useCallback(async () => {
    if (!listing || importing) return undefined;
    const items = buildSelections(listing, choices);
    if (items.length === 0) return undefined;
    setImporting(true);
    try {
      return await window.harbormaster.core.importItems({
        items,
        ...(includeOlder ? { includeOlder: true } : {}),
      });
    } finally {
      setImporting(false);
    }
  }, [listing, choices, includeOlder, importing]);

  return {
    listing,
    loading,
    error,
    choices,
    includeOlder,
    showHidden,
    importing,
    count,
    setIncludeOlder,
    setShowHidden,
    refresh: () => void load(includeOlder),
    toggle: (candidate) => setChoices((c) => toggleRow(c, candidate)),
    toggleGroupOf: (group) => setChoices((c) => toggleGroup(c, group)),
    rename: (candidate, title) =>
      setChoices((c) => setTitle(c, candidate, title)),
    pick: (candidate, sessionId) =>
      setChoices((c) => pickSession(c, candidate, sessionId)),
    fork: (candidate) => setChoices((c) => forkInstead(c, candidate)),
    unfork: (candidate) => setChoices((c) => cancelFork(c, candidate)),
    importSelected,
  };
}
