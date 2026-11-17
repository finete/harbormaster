// Manager helper: the Settings workflow (docs/settings.md S4/S6/S8/S12).
// Reads (`getSettings`), the one generic checked write (`updateSettings`),
// and the change reactions that run for every config change whatever its
// origin — core's own writes and hand edits of config.json alike — so a
// side effect never depends on which surface changed a value. Validation
// is the pure engine's (engines/settings.ts); file I/O and the watcher are
// ConfigAccess's.

import type { CoreLogger } from "../contracts/logger.js";
import type { GlobalConfig } from "../contracts/model.js";
import type { JsonSchema } from "../contracts/rules.js";
import type { ConfigAccess, ConfigChange } from "../contracts/services.js";
import {
  type ConfigFileError,
  SETTINGS_DESCRIPTION,
  type SettingsHarnessOption,
  type SettingsPatch,
  type SettingsSnapshot,
  type SettingsSource,
} from "../contracts/settings.js";
import { expandHome } from "../engines/onboarding.js";
import { sourceSettingsProblems } from "../engines/rules/source-settings.js";
import {
  affectsConfiguration,
  changedConfigKeys,
  explicitSettingKeys,
  settingsValues,
  validateSettingsPatch,
} from "../engines/settings.js";
import type { CoreEventBus } from "../utilities/event-bus.js";

/** Global settings a repository entry (`repositories.<id>.<field>`) can override (S8). */
const REPOSITORY_OVERRIDES: ReadonlyArray<{
  key: string;
  field: "defaultHarness" | "bypassPermissions";
}> = [
  { key: "launch.defaultHarness", field: "defaultHarness" },
  { key: "launch.bypassPermissions", field: "bypassPermissions" },
];

export interface SettingsRuntimeDeps {
  config: ConfigAccess;
  events: CoreEventBus;
  logger: CoreLogger;
  /** Selectable agents for this config (built-ins, then custom). */
  harnesses(config: GlobalConfig): SettingsHarnessOption[];
  /** Repository rediscovery under the config's `codeRoot` (warms the discovery cache). */
  rediscover(config: GlobalConfig): Promise<unknown>;
  /**
   * Registered event sources (built-ins, then loaded add-ons) for the
   * GitHub & sources section and `sources.<id>.*` writes (S10); absent =
   * no source list (described `sources.github.*` keys still validate).
   */
  sources?(): Promise<SettingsSourceListing[]>;
  /** Folder checks for `codeRoot`; absent = no existence check. */
  folders?: {
    homeDir(): string;
    isDirectory(path: string): Promise<boolean>;
  };
}

/** One registered source, as the rules runtime lists it. */
export interface SettingsSourceListing {
  id: string;
  title?: string;
  settingsSchema?: JsonSchema;
  builtin: boolean;
  addon?: { name: string; description?: string };
}

export class SettingsRuntime {
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: SettingsRuntimeDeps) {
    // `config` may be absent on a bare test-built manager.
    this.unsubscribe = deps.config?.onChange?.((change) =>
      this.changed(change),
    );
  }

  /** Start watching config.json for hand edits (S4). */
  watch(): void {
    this.deps.config.startWatching?.();
  }

  /** Stop watching and stop reacting (shutdown). */
  dispose(): void {
    this.deps.config?.stopWatching?.();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async get(): Promise<SettingsSnapshot> {
    const access = this.deps.config;
    const snapshot = access.snapshot
      ? await access.snapshot()
      : await access.load().then((config) => ({
          config,
          raw: config as unknown as Record<string, unknown>,
          error: undefined as ConfigFileError | undefined,
        }));
    const { config, raw, error } = snapshot;
    const overriddenIn: Record<string, number> = {};
    const repositories = Object.values(config.repositories ?? {});
    for (const { key, field } of REPOSITORY_OVERRIDES) {
      overriddenIn[key] = repositories.filter(
        (entry) => entry?.[field] !== undefined,
      ).length;
    }
    const listings = (await this.listSources()) ?? [];
    return {
      description: SETTINGS_DESCRIPTION,
      values: settingsValues(config),
      explicit: explicitSettingKeys(raw),
      overriddenIn,
      harnesses: this.deps.harnesses(config),
      sources: listings.map((listing) => sourceView(listing, config)),
      ...(error ? { error } : {}),
    };
  }

  /** The registered sources; `undefined` when this core has no source list (or it failed). */
  private async listSources(): Promise<SettingsSourceListing[] | undefined> {
    if (!this.deps.sources) return undefined;
    try {
      return await this.deps.sources();
    } catch (error) {
      this.deps.logger.warn("config", "listing sources failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async update(patch: SettingsPatch): Promise<SettingsSnapshot> {
    const access = this.deps.config;
    if (!access.applySettings) throw new Error("settings are not writable");
    const config = await access.load();
    const touchesSources = Object.keys(patch ?? {}).some((key) =>
      key.startsWith("sources."),
    );
    const sources = touchesSources ? await this.listSources() : undefined;
    const { values, problems } = validateSettingsPatch(patch, {
      harnessIds: this.deps.harnesses(config).map((option) => option.id),
      ...(sources ? { sources } : {}),
      sourceSettings: (id) => config.sources?.[id]?.settings ?? {},
    });
    const root = values.codeRoot;
    if (typeof root === "string" && this.deps.folders) {
      const expanded = expandHome(root, this.deps.folders.homeDir());
      if (!(await this.deps.folders.isDirectory(expanded))) {
        problems.push(`${expanded} is not a folder.`);
      } else {
        values.codeRoot = expanded;
      }
    }
    if (problems.length > 0) throw new Error(problems.join(" "));
    if (Object.keys(values).length > 0) {
      try {
        await access.applySettings({ set: values });
      } catch (error) {
        // The file loader's last word (e.g. a branch prefix git rejects):
        // drop its "Invalid Harbormaster config at <path>: " wrapper.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          message.replace(/^Invalid Harbormaster config at .*?: /, ""),
        );
      }
    }
    return this.get();
  }

  /** One config change (any origin): tell frontends, then react. */
  private changed(change: ConfigChange): void {
    const changedKeys = change.error
      ? []
      : changedConfigKeys(change.previous, change.config);
    this.deps.events.emit("config-changed", {
      changedKeys,
      origin: change.origin,
      ...(change.error ? { error: change.error } : {}),
    });
    if (change.error) {
      this.deps.logger.warn(
        "config",
        `config.json is invalid, keeping the last good config: ${change.error.message}${
          change.error.line !== undefined ? ` (line ${change.error.line})` : ""
        }`,
      );
      return;
    }
    void this.react(change.config, changedKeys).catch((error: unknown) => {
      this.deps.logger.warn("config", "config change reaction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * The change reactions (S6). `automation` and `sources.*` need none
   * beyond the `config-changed` event: the refresh tick reads both fresh
   * each pass (as `setRulesEnabled` / `setSourceEnabled` always relied on).
   */
  private async react(
    config: GlobalConfig,
    changedKeys: readonly string[],
  ): Promise<void> {
    if (changedKeys.length === 0) return;
    this.deps.logger.info(
      "config",
      `config changed: ${changedKeys.join(", ")}`,
    );
    if (
      affectsConfiguration(changedKeys, "codeRoot") ||
      affectsConfiguration(changedKeys, "repositories")
    ) {
      await this.deps.rediscover(config);
    }
    if (affectsConfiguration(changedKeys, "launch.defaultHarness")) {
      const id = config.launch?.defaultHarness;
      const known = this.deps.harnesses(config).map((option) => option.id);
      if (id && known.length > 0 && !known.includes(id)) {
        this.deps.logger.warn(
          "config",
          `default agent "${id}" is not available (known: ${known.join(", ")})`,
        );
      }
    }
  }
}

/** A source's Settings view from its listing and the current config. */
function sourceView(
  listing: SettingsSourceListing,
  config: GlobalConfig,
): SettingsSource {
  const entry = config.sources?.[listing.id];
  const settings = { ...(entry?.settings ?? {}) };
  return {
    id: listing.id,
    label: listing.title ?? listing.id,
    builtin: listing.builtin,
    ...(listing.addon ? { addon: listing.addon } : {}),
    enabled: entry?.enabled !== false,
    enabledExplicit: entry?.enabled !== undefined,
    ...(listing.settingsSchema
      ? { settingsSchema: listing.settingsSchema }
      : {}),
    settings,
    explicit: Object.keys(settings),
    problems: sourceSettingsProblems(
      listing.id,
      listing.settingsSchema,
      settings,
    ),
  };
}
