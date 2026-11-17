// The Settings page's model (docs/settings.md S4/S5): core's settings
// snapshot, re-read on every `config-changed` (a write from here, another
// window, or a hand edit of config.json), and the one generic write. The
// renderer never reads or writes config.json itself.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsSnapshot, SettingValue } from "../../../preload/api";
import { ipcErrorText } from "./settings-form";

export interface SettingsModel {
  /** `null` until the first read lands. */
  snapshot: SettingsSnapshot | null;
  /** The first read failed (core unreachable); the page says so. */
  loadError: string | null;
  /**
   * Write one setting (`null` resets it to its default). Resolves the
   * rejection message when core refused it (shown on the row), else
   * `undefined`.
   */
  update(key: string, value: SettingValue | null): Promise<string | undefined>;
}

export function useSettings(): SettingsModel {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest read may land (a slow read must not undo a newer one).
  const readSeq = useRef(0);

  const refresh = useCallback(() => {
    const seq = ++readSeq.current;
    window.harbormaster.core
      .getSettings()
      .then((next) => {
        if (seq !== readSeq.current) return;
        setSnapshot(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (seq === readSeq.current) setLoadError(ipcErrorText(error));
      });
  }, []);

  useEffect(() => {
    refresh();
    return window.harbormaster.core.onConfigChanged(() => refresh());
  }, [refresh]);

  const update = useCallback(
    async (
      key: string,
      value: SettingValue | null,
    ): Promise<string | undefined> => {
      const seq = ++readSeq.current;
      try {
        const next = await window.harbormaster.core.updateSettings({
          [key]: value,
        });
        if (seq === readSeq.current) setSnapshot(next);
        return undefined;
      } catch (error) {
        return ipcErrorText(error);
      }
    },
    [],
  );

  return { snapshot, loadError, update };
}
