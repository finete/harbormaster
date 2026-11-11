// React glue for "Open in …": the host's app list (fetched from main once
// per renderer and shared by every button/menu) and the last-used app id
// (localStorage, shared live across every mounted button so the workspace
// header and the sidebar menu always agree on the default).

import { useEffect, useState, useSyncExternalStore } from "react";
import type { OpenInAppInfo } from "../../../preload/api";
import { describeThrown, pushToast } from "../toast";
import { readLastOpenInAppId, writeLastOpenInAppId } from "./open-in";

let appsPromise: Promise<OpenInAppInfo[]> | null = null;
let appsCache: OpenInAppInfo[] | null = null;

function loadOpenInApps(): Promise<OpenInAppInfo[]> {
  appsPromise ??= window.harbormaster.app
    .openInApps()
    .then((apps) => {
      appsCache = apps;
      return apps;
    })
    .catch(() => {
      appsPromise = null; // retry on the next mount
      return [];
    });
  return appsPromise;
}

/** The "Open in" apps available on this host (empty while loading). */
export function useOpenInApps(): OpenInAppInfo[] {
  const [apps, setApps] = useState<OpenInAppInfo[]>(() => appsCache ?? []);
  useEffect(() => {
    let cancelled = false;
    void loadOpenInApps().then((next) => {
      if (!cancelled) setApps(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return apps;
}

const lastAppListeners = new Set<() => void>();

function subscribeLastApp(listener: () => void): () => void {
  lastAppListeners.add(listener);
  return () => lastAppListeners.delete(listener);
}

function lastAppSnapshot(): string | undefined {
  return readLastOpenInAppId(window.localStorage);
}

/** The persisted last-used app id (`harbormaster.openIn.lastApp`). */
export function useLastOpenInAppId(): string | undefined {
  return useSyncExternalStore(subscribeLastApp, lastAppSnapshot);
}

/**
 * Open folder `path` in `app` via main (allowlisted there), remembering
 * `app` as the new default. A refusal or launch failure becomes a toast.
 */
export async function openPathIn(
  path: string,
  app: OpenInAppInfo,
): Promise<void> {
  writeLastOpenInAppId(window.localStorage, app.id);
  for (const listener of Array.from(lastAppListeners)) listener();
  try {
    const result = await window.harbormaster.app.openIn(path, app.id);
    if (!result.ok) pushToast(`Open in ${app.label}: ${result.error}`);
  } catch (error) {
    pushToast(`Open in ${app.label}: ${describeThrown(error)}`);
  }
}

/** Copy `path` to the clipboard through main (works without window focus). */
export function copyPath(path: string): void {
  void window.harbormaster.app.copyText(path);
}
