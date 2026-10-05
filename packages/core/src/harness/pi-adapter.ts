// Pi harness adapter — the only adapter v1 needs (see /AGENTS.md: "Agent
// harnesses are adapters" and /docs/design-decisions.md #13). Pure launch-
// spec logic plus a presence read through `SessionPresenceAccess`; no
// process spawning here (accessor separation is a hard rule — ptys are a
// frontend resource, see /ai/prds/architecture.md).

import { SessionPresenceAccess } from "../access/session-presence-access.js";
import type {
  BuildLaunchSpecInput,
  HarnessAdapter,
  LaunchSpec,
  PresenceStatus,
} from "../contracts/harness.js";
import type { Clock, PresenceAccess } from "../contracts/services.js";
import { SystemClock } from "../utilities/defaults.js";
import { resolveStatePaths } from "../utilities/state-paths.js";
import {
  derivePresenceStatus,
  type PresenceLivenessOptions,
} from "./presence-heuristics.js";

export interface PiHarnessAdapterOptions {
  /**
   * Per-user state directory root. Used to locate the presence registry
   * (`<stateDir>/presence`) unless `presence` is supplied directly.
   */
  stateDir?: string;
  /** Inject a presence access directly (tests, or a non-default layout). */
  presence?: PresenceAccess;
  clock?: Clock;
  /** Optional process-liveness probe forwarded to the presence heuristic. */
  isAlive?: (pid: number) => boolean;
}

/** Marker env var every launched Pi session can check to detect it is Harbormaster-hosted. */
const MARKER_ENV = "HARBORMASTER";
const TASK_ID_ENV = "HARBORMASTER_TASK_ID";
const STATE_DIR_ENV = "HARBORMASTER_STATE_DIR";

export class PiHarnessAdapter implements HarnessAdapter {
  private readonly presenceAccess: PresenceAccess;
  private readonly clock: Clock;
  private readonly livenessOptions: PresenceLivenessOptions;

  constructor(options: PiHarnessAdapterOptions = {}) {
    this.presenceAccess =
      options.presence ??
      new SessionPresenceAccess(
        resolveStatePaths(options.stateDir).presenceDir,
      );
    this.clock = options.clock ?? new SystemClock();
    this.livenessOptions = options.isAlive ? { isAlive: options.isAlive } : {};
  }

  buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec {
    const env: Record<string, string> = {
      [MARKER_ENV]: "1",
      [TASK_ID_ENV]: input.taskId,
      [STATE_DIR_ENV]: input.stateDir,
    };
    return {
      command: "pi",
      args: input.initialPrompt ? [input.initialPrompt] : [],
      cwd: input.workspacePath,
      env,
    };
  }

  async presence(taskId: string): Promise<PresenceStatus> {
    const record = await this.presenceAccess.read(taskId);
    return derivePresenceStatus(record, this.clock.now(), this.livenessOptions);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error(
      "PiHarnessAdapter.stopHeadless is not implemented yet (wave 4: needs frontend/process-owner cooperation)",
    );
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error(
      "PiHarnessAdapter.attach is not implemented yet (wave 4: needs frontend pty cooperation)",
    );
  }
}
