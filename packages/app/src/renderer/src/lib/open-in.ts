// Pure helpers behind the "Open in …" button (components/OpenInButton.tsx)
// and the sidebar row's "Open in" menu items: the persisted last-used app
// and the menu grouping. No React/DOM, so they are unit-testable in node
// (tests/open-in.test.ts). The catalog itself and every launch live in main
// (main/open-in.ts); the renderer only ever sends a catalog id + a path.

import type { OpenInAppInfo } from "../../../preload/api";

/** localStorage key of the last app the user opened a worktree in. */
export const OPEN_IN_LAST_APP_KEY = "harbormaster.openIn.lastApp";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readLastOpenInAppId(storage: StorageLike): string | undefined {
  try {
    return storage.getItem(OPEN_IN_LAST_APP_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLastOpenInAppId(storage: StorageLike, id: string): void {
  try {
    storage.setItem(OPEN_IN_LAST_APP_KEY, id);
  } catch {
    // Storage full/blocked: the default just isn't remembered.
  }
}

/**
 * The app the split button's main part opens in: the last used one when it
 * is still installed, else the file manager, else the first available app.
 */
export function defaultOpenInApp(
  apps: readonly OpenInAppInfo[],
  lastId: string | undefined,
): OpenInAppInfo | undefined {
  return (
    apps.find((app) => app.id === lastId) ??
    apps.find((app) => app.kind === "file-manager") ??
    apps[0]
  );
}

export interface OpenInGroup {
  kind: OpenInAppInfo["kind"];
  label: string;
  apps: OpenInAppInfo[];
}

const GROUPS: { kind: OpenInAppInfo["kind"]; label: string }[] = [
  { kind: "file-manager", label: "File manager" },
  { kind: "editor", label: "Editors" },
  { kind: "terminal", label: "Terminals" },
];

/** Menu sections in fixed order (file manager, editors, terminals); empty ones dropped. */
export function groupOpenInApps(apps: readonly OpenInAppInfo[]): OpenInGroup[] {
  return GROUPS.map(({ kind, label }) => ({
    kind,
    label,
    apps: apps.filter((app) => app.kind === kind),
  })).filter((group) => group.apps.length > 0);
}
