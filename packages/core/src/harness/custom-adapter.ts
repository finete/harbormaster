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
  HarnessModelCatalog,
  LaunchSpec,
  PresenceStatus,
} from "../contracts/harness.js";
import type { HarnessMessagingCapabilities } from "../contracts/messaging.js";
import type { CustomAgentConfig } from "../contracts/model.js";
import {
  baseLaunchEnv,
  createPresenceReader,
  type PresenceReaderOptions,
} from "./adapter-common.js";

export const NO_MESSAGING_CAPABILITIES: HarnessMessagingCapabilities = {
  receive: false,
  steer: false,
  followUp: false,
  images: false,
};

export interface CustomHarnessAdapterOptions extends PresenceReaderOptions {
  cliPath?: string;
}

export class CustomHarnessAdapter implements HarnessAdapter {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly messaging: HarnessMessagingCapabilities = {
    ...NO_MESSAGING_CAPABILITIES,
  };
  private readonly readPresence: (taskId: string) => Promise<PresenceStatus>;
  private readonly cliPath: string | undefined;

  constructor(
    private readonly config: CustomAgentConfig,
    options: CustomHarnessAdapterOptions = {},
  ) {
    this.id = config.id;
    this.label = config.label;
    this.command = config.command;
    this.readPresence = createPresenceReader(options);
    this.cliPath = options.cliPath;
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
    const prompt = input.initialPrompt?.trim() ? input.initialPrompt : "";
    const passPrompt = (this.config.promptArg ?? "positional") === "positional";
    return {
      command: this.config.command,
      args: [
        ...(this.config.args ?? []),
        ...(prompt && passPrompt ? [prompt] : []),
      ],
      cwd: input.workspacePath,
      env: baseLaunchEnv(input, this.cliPath),
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
