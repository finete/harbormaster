// "Any CLI" harness adapter (decision R2/R3): a user-configured command
// (`GlobalConfig.agents.custom[]`) run in the task's worktree with the
// standard Harbormaster env. Status comes from OSC 7501 (if the program
// speaks it) and pid liveness only; there is no inbox glue, so its
// messaging capabilities are all off and core refuses sends to it up front;
// no session flags (core still assigns ids, the program just never sees
// them); no model list.

import type {
  BuildLaunchSpecInput,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessModelCatalog,
  HarnessReviewCapability,
  LaunchSpec,
  PresenceStatus,
} from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import type { CustomAgentConfig } from "../contracts/model.js";
import {
  applyOpenUrlEnv,
  baseLaunchEnv,
  createPresenceReader,
  deliverInitialPrompt,
  type PresenceReaderOptions,
  readPromptFileInstruction,
  templateReviewCommand,
} from "./adapter-common.js";
import {
  harnessCommandEnvName,
  harnessLaunchCommand,
  isTerminalShim,
  parseVersionOutput,
} from "./descriptor.js";

export const NO_MESSAGING_CAPABILITIES: HarnessMessagingCapabilities = {
  receive: false,
  steer: false,
  followUp: false,
  images: false,
};

/**
 * A custom agent's descriptor (P2): its one configured command, no install
 * one-liner of ours, and never a version floor (an arbitrary CLI may not
 * even answer `--version`). Review needs the Plannotator binary only when
 * the config declares a `reviewCommand`.
 */
export function customAgentDescriptor(
  config: CustomAgentConfig,
): HarnessDescriptor {
  return {
    id: config.id,
    label: config.label,
    commands: [[config.command]],
    commandEnv: [harnessCommandEnvName(config.id)],
    installHint: `Install ${config.label} so \`${config.command}\` is on PATH.`,
    versionArgs: ["--version"],
    parseVersion: parseVersionOutput,
    configDir: () => undefined,
    reviewPieces: config.reviewCommand?.trim() ? ["binary"] : [],
    isShim: isTerminalShim,
  };
}

/** A custom agent's capabilities (P6): 7501 if it speaks it, nothing delivered. */
export function customAgentCapabilities(
  config: CustomAgentConfig,
): HarnessCapabilities {
  return {
    sessionId: "preassign",
    status: {
      protocol: "osc7501",
      probe: true,
      states: ["idle", "working", "blocked", "done", "error"],
      quirks: [],
    },
    delivery: { steer: false, followUp: false, wakeIdle: false, channels: {} },
    trustPrompt: false,
    fork: false,
    review: Boolean(config.reviewCommand?.trim()),
  };
}

export interface CustomHarnessAdapterOptions extends PresenceReaderOptions {
  cliPath?: string;
}

export class CustomHarnessAdapter implements HarnessAdapter {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly descriptor: HarnessDescriptor;
  readonly capabilities: HarnessCapabilities;
  readonly messaging: HarnessMessagingCapabilities = {
    ...NO_MESSAGING_CAPABILITIES,
  };
  /** Present only when the config declares a `reviewCommand` template. */
  readonly review?: HarnessReviewCapability;
  private readonly readPresence: (taskId: string) => Promise<PresenceStatus>;
  private readonly cliPath: string | undefined;

  constructor(
    private readonly config: CustomAgentConfig,
    options: CustomHarnessAdapterOptions = {},
  ) {
    this.id = config.id;
    this.label = config.label;
    this.command = config.command;
    this.descriptor = customAgentDescriptor(config);
    this.capabilities = customAgentCapabilities(config);
    this.readPresence = createPresenceReader(options);
    this.cliPath = options.cliPath;
    const template = config.reviewCommand?.trim();
    if (template) {
      this.review = {
        command: (target) => templateReviewCommand(template, target),
      };
    }
  }

  async defaults(): Promise<
    Pick<HarnessModelCatalog, "defaultModel" | "defaultThinking">
  > {
    return {};
  }

  async listModels(): Promise<HarnessModelCatalog> {
    return { harness: this.id, label: this.label, models: [] };
  }

  buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec {
    const passPrompt = (this.config.promptArg ?? "positional") === "positional";
    const prompt = passPrompt
      ? deliverInitialPrompt(
          input,
          (text) => [text],
          (path) => [readPromptFileInstruction(path)],
        )
      : { args: [] };
    return {
      command: harnessLaunchCommand(this),
      args: [...(this.config.args ?? []), ...prompt.args],
      cwd: input.workspacePath,
      env: applyOpenUrlEnv(baseLaunchEnv(input, this.cliPath), input),
      ...("promptFile" in prompt && prompt.promptFile
        ? { promptFile: prompt.promptFile }
        : {}),
    };
  }

  presence(taskId: string): Promise<PresenceStatus> {
    return this.readPresence(taskId);
  }

  async stopHeadless(_taskId: string): Promise<void> {
    throw new Error("CustomHarnessAdapter.stopHeadless is not implemented");
  }

  async attach(_taskId: string): Promise<void> {
    throw new Error("CustomHarnessAdapter.attach is not implemented");
  }
}
