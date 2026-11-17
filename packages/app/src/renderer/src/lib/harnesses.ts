// The registered agents as the renderer sees them: core's harness
// descriptors (`CoreCommands.listHarnessDescriptors`, through preload),
// fetched once per window and shared. Frontends never name agents
// (docs/harness-additions.md P2): labels, install hints and version floors
// all come from here.

import { useEffect, useState } from "react";
import type { HarnessDescriptorInfo } from "../../../preload/api";

/**
 * Mirror of core's `DEFAULT_HARNESS_ID`: the agent a task ran on when it
 * records none (tasks from before agents were recorded ran Pi). The
 * renderer never imports core values, only types.
 */
export const DEFAULT_HARNESS_ID = "pi";

let cached: Promise<HarnessDescriptorInfo[]> | undefined;

/** The descriptors, fetched once (a failure retries on the next call). */
export function loadHarnessDescriptors(): Promise<HarnessDescriptorInfo[]> {
  if (!cached) {
    const pending = window.harbormaster.core
      .listHarnessDescriptors()
      .catch((error: unknown) => {
        if (cached === pending) cached = undefined;
        throw error;
      });
    cached = pending;
  }
  return cached;
}

/** Forget the cached descriptors (custom agents were edited). */
export function refreshHarnessDescriptors(): Promise<HarnessDescriptorInfo[]> {
  cached = undefined;
  return loadHarnessDescriptors();
}

/** The descriptors; `null` while loading, `[]` when they could not be read. */
export function useHarnessDescriptors(): HarnessDescriptorInfo[] | null {
  const [descriptors, setDescriptors] = useState<
    HarnessDescriptorInfo[] | null
  >(null);
  useEffect(() => {
    let live = true;
    loadHarnessDescriptors().then(
      (list) => live && setDescriptors(list),
      () => live && setDescriptors([]),
    );
    return () => {
      live = false;
    };
  }, []);
  return descriptors;
}

/** `id`'s display label from `descriptors`, else the id itself. */
export function harnessLabelFrom(
  descriptors: readonly HarnessDescriptorInfo[] | null | undefined,
  id: string,
): string {
  return descriptors?.find((entry) => entry.id === id)?.label ?? id;
}

/** `id`'s display label (the id until the descriptors load). */
export function useHarnessLabel(id: string): string {
  return harnessLabelFrom(useHarnessDescriptors(), id);
}
