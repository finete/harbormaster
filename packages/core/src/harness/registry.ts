// The harness registry (decision R8): every agent a task can run on, keyed
// by `HarnessAdapter.id` (`Task.harness`). Built-ins are Pi and Claude
// Code; user-configured "any CLI" agents (`GlobalConfig.agents.custom[]`)
// are added per call from the current config, so editing the config needs
// no restart. A custom agent can never shadow a built-in id.

import type { HarnessAdapter } from "../contracts/harness.js";
import {
  type CustomAgentConfig,
  DEFAULT_HARNESS_ID,
  DEFAULT_LAUNCH_BYPASS_PERMISSIONS,
  type GlobalConfig,
  type RepositoryConfig,
} from "../contracts/model.js";
import type { PresenceReaderOptions } from "./adapter-common.js";
import { ClaudeCodeHarnessAdapter } from "./claude-code-adapter.js";
import { CustomHarnessAdapter } from "./custom-adapter.js";
import { PiHarnessAdapter } from "./pi-adapter.js";

export interface HarnessRegistryOptions extends PresenceReaderOptions {
  /** Absolute `harbormaster` CLI path handed to every adapter (hooks, MCP). */
  cliPath?: string;
  /** Used for an id nothing else knows (a task created on an agent since removed). Defaults to the first built-in. */
  fallback?: HarnessAdapter;
}

export class HarnessRegistry {
  private readonly builtins: Map<string, HarnessAdapter>;
  private readonly customCache = new Map<
    string,
    { key: string; adapter: HarnessAdapter }
  >();

  constructor(
    builtins: readonly HarnessAdapter[],
    private readonly options: HarnessRegistryOptions = {},
  ) {
    this.builtins = new Map(builtins.map((adapter) => [adapter.id, adapter]));
  }

  /** Built-ins first (registration order), then valid custom agents in config order. */
  list(custom: readonly CustomAgentConfig[] = []): HarnessAdapter[] {
    const adapters = [...this.builtins.values()];
    const seen = new Set(adapters.map((adapter) => adapter.id));
    for (const config of custom) {
      if (seen.has(config.id)) continue;
      seen.add(config.id);
      adapters.push(this.customAdapter(config));
    }
    return adapters;
  }

  /** The adapter registered under `id`, if any. */
  get(
    id: string,
    custom: readonly CustomAgentConfig[] = [],
  ): HarnessAdapter | undefined {
    const builtin = this.builtins.get(id);
    if (builtin) return builtin;
    const config = custom.find((entry) => entry.id === id);
    return config ? this.customAdapter(config) : undefined;
  }

  /** The adapter a task runs on: its own id, else Pi (`DEFAULT_HARNESS_ID`), else the fallback. */
  resolve(
    id: string | undefined,
    custom: readonly CustomAgentConfig[] = [],
  ): HarnessAdapter {
    const adapter =
      this.get(id ?? DEFAULT_HARNESS_ID, custom) ??
      this.options.fallback ??
      this.builtins.get(DEFAULT_HARNESS_ID) ??
      [...this.builtins.values()][0];
    if (!adapter) throw new Error("No agent harness is registered");
    return adapter;
  }

  private customAdapter(config: CustomAgentConfig): HarnessAdapter {
    const key = JSON.stringify(config);
    const cached = this.customCache.get(config.id);
    if (cached?.key === key) return cached.adapter;
    const adapter = new CustomHarnessAdapter(config, {
      ...(this.options.stateDir ? { stateDir: this.options.stateDir } : {}),
      ...(this.options.presence ? { presence: this.options.presence } : {}),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.isAlive ? { isAlive: this.options.isAlive } : {}),
      ...(this.options.cliPath ? { cliPath: this.options.cliPath } : {}),
    });
    this.customCache.set(config.id, { key, adapter });
    return adapter;
  }
}

/** The built-in registry: Pi and Claude Code sharing one presence registry and CLI path. */
export function createHarnessRegistry(
  options: HarnessRegistryOptions = {},
): HarnessRegistry {
  const shared: PresenceReaderOptions & { cliPath?: string } = {
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    ...(options.presence ? { presence: options.presence } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.isAlive ? { isAlive: options.isAlive } : {}),
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
  };
  return new HarnessRegistry(
    [new PiHarnessAdapter(shared), new ClaudeCodeHarnessAdapter(shared)],
    options,
  );
}

/**
 * Which agent a new task runs on (decision R8), fixed for its lifetime:
 * the explicit choice (composer dropdown / `launch_task`'s `harness`),
 * else the parent's (children inherit), else the repository's
 * `defaultHarness`, else `launch.defaultHarness`, else Pi.
 */
export function resolveNewTaskHarness(input: {
  requested?: string | undefined;
  parentHarness?: string | undefined;
  repository?: RepositoryConfig | undefined;
  config: GlobalConfig;
}): string {
  return (
    input.requested?.trim() ||
    input.parentHarness ||
    input.repository?.defaultHarness ||
    input.config.launch?.defaultHarness ||
    DEFAULT_HARNESS_ID
  );
}

/**
 * Whether a launched task skips permission prompts (decision R7): the
 * launch's own choice, else the repository's, else the global setting,
 * else `true`.
 */
export function resolveLaunchBypass(input: {
  requested?: boolean | undefined;
  repository?: RepositoryConfig | undefined;
  config: GlobalConfig;
}): boolean {
  return (
    input.requested ??
    input.repository?.bypassPermissions ??
    input.config.launch?.bypassPermissions ??
    DEFAULT_LAUNCH_BYPASS_PERMISSIONS
  );
}
