// The built-in event sources, in the same shape as addon sources. They are
// listed (read-only) by `listAddons` as the `harbormaster-builtin` addon.

import type { Source } from "../../contracts/rules.js";
import { githubSource } from "./github-source.js";
import { harbormasterSource } from "./harbormaster-source.js";
import { versionEndpointSource } from "./version-endpoint-source.js";

/** Snapshot order within a tick: the board first, then GitHub, then deployments. */
export const builtinSources: readonly Source[] = Object.freeze([
  harbormasterSource,
  githubSource,
  versionEndpointSource,
]);

export const BUILTIN_ADDON_NAME = "harbormaster-builtin";

export * from "./github-source.js";
export * from "./harbormaster-source.js";
export * from "./version-endpoint-source.js";
