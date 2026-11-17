// Live settings values for features outside the Settings page (the board's
// "Automation paused" banner, the notification switch; docs/settings.md
// S11/S13): core's `getSettings` values and explicit keys, re-read on every
// `config-changed` (a Settings write or a hand edit of config.json). One
// shared subscription per window (lib/shared-store.ts); the renderer never
// reads config.json itself.

import { useSyncExternalStore } from "react";
import type { SettingsSnapshot } from "../../../preload/api";
import { createSharedStore } from "./shared-store";

/** What features read: effective values and the keys config.json sets. */
export type ConfigValues = Pick<SettingsSnapshot, "values" | "explicit">;

export const configValuesStore = createSharedStore<ConfigValues | null>(
  null,
  (set) => {
    const core = window.harbormaster?.core;
    if (!core?.getSettings) return () => {};
    // Only the newest read may land.
    let seq = 0;
    const read = (): void => {
      const mine = ++seq;
      core
        .getSettings()
        .then((settings) => {
          if (mine === seq) {
            set({ values: settings.values, explicit: settings.explicit });
          }
        })
        .catch(() => {
          // Keep the last values; the next config change re-reads.
        });
    };
    read();
    return core.onConfigChanged(() => read());
  },
);

/** The live settings values; `null` until the first read lands. */
export function useConfigValues(): ConfigValues | null {
  return useSyncExternalStore(
    configValuesStore.subscribe,
    configValuesStore.getSnapshot,
  );
}
