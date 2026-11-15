// "N worktrees … belong to no task" toast: closing it with ✕ is remembered
// (root + orphan count) so the next launch or 6h rescan stays quiet. It
// shows again only when the orphans grow past what was dismissed, or sit
// under a different root: that is new information, the same pile is not.

/** localStorage key of the last dismissed orphan warning. */
export const ORPHAN_WARNING_DISMISSED_KEY =
  "harbormaster.orphanWarning.dismissed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface Dismissed {
  root: string;
  count: number;
}

function readDismissed(storage: StorageLike): Dismissed | undefined {
  try {
    const raw = storage.getItem(ORPHAN_WARNING_DISMISSED_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Dismissed>;
    if (typeof parsed.root !== "string" || typeof parsed.count !== "number") {
      return undefined;
    }
    return { root: parsed.root, count: parsed.count };
  } catch {
    return undefined;
  }
}

/** Whether a scan's warning should be shown, given what the user dismissed before. */
export function shouldShowOrphanWarning(
  storage: StorageLike,
  report: { root: string; count: number },
): boolean {
  const dismissed = readDismissed(storage);
  if (!dismissed) return true;
  return dismissed.root !== report.root || report.count > dismissed.count;
}

/** Remember that the user closed the warning for this root and count. */
export function dismissOrphanWarning(
  storage: StorageLike,
  report: { root: string; count: number },
): void {
  try {
    storage.setItem(
      ORPHAN_WARNING_DISMISSED_KEY,
      JSON.stringify({ root: report.root, count: report.count }),
    );
  } catch {
    // Storage blocked: the warning just comes back next scan.
  }
}
