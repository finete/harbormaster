// The inbox model (docs/release-plan.md "Inbox"): the pure assembly in
// lib/inbox-items.ts fed by the shared live stores (board, presence,
// approvals, messaging chips, persisted items, ready-to-land), plus the
// renderer-side dismiss/snooze state of derived items (localStorage) and
// the optional priority filter, which core evaluates
// (`evaluateInboxPriority`) so the app and `harbormaster inbox` agree.
// App calls this once and hands the model to the sidebar badge and the
// inbox view.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  flattenBoard,
  useApprovals,
  useBoard,
  useInboxItems,
  useMessagingStates,
  usePresenceMap,
  useReadyToLand,
} from "../core-client";
import { pushToast } from "../toast";
import {
  assembleInbox,
  INBOX_LOCAL_STATE_KEY,
  type InboxEntry,
  type LocalInboxState,
  parseLocalState,
  priorityCount,
  priorityInputs,
  pruneLocalState,
  visibleEntries,
} from "./inbox-items";
import { isWaitingOnParentActive } from "./task-messaging-chips";
import { useNow } from "./use-now";

export interface InboxModel {
  /** Visible entries (not dismissed, not snoozed), newest first. */
  entries: InboxEntry[];
  /** The priority filter's verdict per entry id (absent = the entry's default). */
  priorities: ReadonlyMap<string, boolean>;
  /** Visible Priority entries: the sidebar badge. */
  priorityCount: number;
  /** Agents with a turn running right now (the empty state's line). */
  workingCount: number;
  dismiss(entry: InboxEntry): Promise<void>;
  snooze(entry: InboxEntry, until: Date): Promise<void>;
  /** Dismiss every dismissable Other entry. */
  clearOther(): Promise<void>;
}

function readLocal(): LocalInboxState {
  try {
    return parseLocalState(window.localStorage.getItem(INBOX_LOCAL_STATE_KEY));
  } catch {
    return parseLocalState(null);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useInbox(): InboxModel {
  const columns = useBoard();
  const presence = usePresenceMap();
  const approvals = useApprovals();
  const messaging = useMessagingStates();
  const items = useInboxItems();
  const readyToLand = useReadyToLand();
  // A 15s tick so snoozes end and new entries' "time since" stay current.
  const now = useNow(15_000);
  const [local, setLocal] = useState<LocalInboxState>(() =>
    pruneLocalState(readLocal(), Date.now()),
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(INBOX_LOCAL_STATE_KEY, JSON.stringify(local));
    } catch {
      // Storage unavailable: dismissals last this session only.
    }
  }, [local]);

  const rows = useMemo(() => flattenBoard(columns), [columns]);
  const waitingOnParent = useMemo(() => {
    const ids = new Set<string>();
    for (const [taskId, state] of messaging) {
      if (
        state.waitingOnParent &&
        isWaitingOnParentActive(state.waitingOnParent, now)
      ) {
        ids.add(taskId);
      }
    }
    return ids;
  }, [messaging, now]);

  const all = useMemo(
    () =>
      assembleInbox({
        tasks: rows,
        presence,
        approvals,
        items,
        readyToLand,
        waitingOnParent,
      }),
    [rows, presence, approvals, items, readyToLand, waitingOnParent],
  );
  const entries = useMemo(
    () => visibleEntries(all, local, now),
    [all, local, now],
  );

  // The optional CEL override lives in core; until it answers, defaults hold.
  const repoOf = useMemo(() => {
    const repos = new Map(
      rows.map((row) => [row.task.id, row.task.repositoryId]),
    );
    return (taskId: string) => repos.get(taskId);
  }, [rows]);
  const inputs = useMemo(() => priorityInputs(all, repoOf), [all, repoOf]);
  const inputsKey = JSON.stringify(inputs);
  const [priorities, setPriorities] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content (`inputsKey`), not identity.
  useEffect(() => {
    let cancelled = false;
    if (inputs.length === 0) {
      setPriorities(new Map());
      return;
    }
    void window.harbormaster.core
      .evaluateInboxPriority(inputs)
      .then((verdicts) => {
        if (cancelled) return;
        setPriorities(
          new Map(
            inputs.map((input, index) => [
              input.id,
              verdicts[index] ?? input.priority,
            ]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [inputsKey]);

  const workingCount = useMemo(
    () => Object.values(presence).filter((badge) => badge.runningTurn).length,
    [presence],
  );

  const dismiss = useCallback(async (entry: InboxEntry): Promise<void> => {
    if (!entry.dismissable) return;
    if (entry.persisted) {
      try {
        await window.harbormaster.core.resolveInboxItem(entry.id);
      } catch (error) {
        pushToast(errorText(error));
      }
      return;
    }
    setLocal((previous) => ({
      ...previous,
      dismissed: {
        ...previous.dismissed,
        [entry.id]: new Date().toISOString(),
      },
    }));
  }, []);

  const snooze = useCallback(
    async (entry: InboxEntry, until: Date): Promise<void> => {
      if (entry.persisted) {
        try {
          await window.harbormaster.core.resolveInboxItem(entry.id, {
            snoozeUntil: until.toISOString(),
          });
        } catch (error) {
          pushToast(errorText(error));
        }
        return;
      }
      setLocal((previous) => ({
        ...previous,
        snoozed: { ...previous.snoozed, [entry.id]: until.toISOString() },
      }));
    },
    [],
  );

  const clearOther = useCallback(async (): Promise<void> => {
    const other = entries.filter(
      (entry) =>
        entry.dismissable && !(priorities.get(entry.id) ?? entry.priority),
    );
    const derived = other.filter((entry) => !entry.persisted);
    if (derived.length > 0) {
      const at = new Date().toISOString();
      setLocal((previous) => ({
        ...previous,
        dismissed: {
          ...previous.dismissed,
          ...Object.fromEntries(derived.map((entry) => [entry.id, at])),
        },
      }));
    }
    await Promise.all(
      other
        .filter((entry) => entry.persisted)
        .map((entry) =>
          window.harbormaster.core
            .resolveInboxItem(entry.id)
            .catch((error: unknown) => pushToast(errorText(error))),
        ),
    );
  }, [entries, priorities]);

  return {
    entries,
    priorities,
    priorityCount: priorityCount(entries, priorities),
    workingCount,
    dismiss,
    snooze,
    clearOther,
  };
}
