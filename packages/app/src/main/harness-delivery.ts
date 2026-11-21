// Follow-up and idle wake-up through a harness's own "deliver" command
// (docs/harness-additions.md X5: Codex's `codex queue --thread <id>
// --message <text>`). Core builds the command (`harnessDeliverCommand`);
// main, the process owner, runs it. Keystrokes are never the primary path.
//
// A queued message stays `pending` in core until the agent confirms it
// took it: the next prompt boundary (its UserPromptSubmit hook, which also
// claims the message there, without repeating the text) or a 7501
// `working` report for the task. Unconfirmed after
// `QUEUE_CONFIRM_MS`, the text is typed into the task's primary pty once
// the agent is at its prompt (claiming the message first); until then it
// stays pending, the existing "not delivered yet" state. Pure logic with
// injected effects (tests/harness-delivery.test.ts).

import type { HarnessDeliverCommand, TaskMessage } from "@harbormaster/core";
import { buildInboxMessageText } from "@harbormaster/core";

/** How long a queued message may go unconfirmed before main types it instead. */
export const QUEUE_CONFIRM_MS = 60_000;

/** One queued delivery waiting for the agent's confirmation. */
export interface QueuedDelivery {
  taskId: string;
  /** Core message ids it carries (claimed on confirmation or fallback). */
  messageIds: string[];
  /** The text handed to the harness (typed as-is on fallback). */
  text: string;
  sentAt: number;
  /** The text is the user's own submit (the Review button), not an agent's message: typing it counts as the user typing. */
  userInput: boolean;
}

export interface HarnessDeliveryDeps {
  now(): number;
  /** Runs the harness's deliver command; resolves whether it succeeded (exit 0). */
  run(command: HarnessDeliverCommand): Promise<boolean>;
  /** Claims exactly these pending messages (core `claimInboxMessages` with `messageIds`); resolves how many were still pending. */
  claim(taskId: string, messageIds: string[]): Promise<number>;
  /** Types `text` + Enter into the task's primary pty; whether it landed. */
  type(taskId: string, text: string): Promise<boolean>;
  /**
   * Records "the user typed into this task" (core `recordUserInput`). Called
   * only for the user's own submit (the Review command) once it was typed,
   * never for an agent's message the app types on its behalf.
   */
  recordUserInput(taskId: string): void;
  onEvent?(event: string, details: Record<string, unknown>): void;
}

/**
 * The text one batch of pending messages is delivered as: each message's
 * inbox text (header, body, attachments, trust line), joined like
 * `inbox_claim` does, so the agent reads exactly what the hooks would
 * have handed it.
 */
export function queueTextFor(messages: readonly TaskMessage[]): string {
  return messages
    .map((message) => buildInboxMessageText(message))
    .join("\n\n---\n\n");
}

/**
 * Pending messages a wake pass may deliver through the harness command:
 * addressed to the task and pending, oldest first, minus the Review
 * button's own messages (route `user`), which the review transport owns.
 */
export function deliverableMessages(
  taskId: string,
  messages: readonly TaskMessage[],
): TaskMessage[] {
  return messages
    .filter(
      (message) =>
        message.targetTaskId === taskId &&
        message.status === "pending" &&
        message.route !== "user",
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Queued deliveries per task (at most one in flight each), with confirmation and the typing fallback. */
export class HarnessDeliveries {
  private readonly inFlight = new Map<string, QueuedDelivery>();
  private readonly busy = new Set<string>();

  constructor(private readonly deps: HarnessDeliveryDeps) {}

  /** Whether a delivery for the task waits for confirmation. */
  has(taskId: string): boolean {
    return this.inFlight.has(taskId) || this.busy.has(taskId);
  }

  pending(taskId: string): QueuedDelivery | undefined {
    return this.inFlight.get(taskId);
  }

  /**
   * Runs `command` and tracks the delivery until confirmed; whether the
   * harness accepted it. `options.userInput` marks the Review button's
   * command, the only delivery that is a user action.
   */
  async send(
    taskId: string,
    command: HarnessDeliverCommand,
    text: string,
    messageIds: string[],
    options: { userInput?: boolean } = {},
  ): Promise<boolean> {
    if (this.has(taskId)) return false;
    this.busy.add(taskId);
    try {
      const ok = await this.deps.run(command).catch(() => false);
      this.deps.onEvent?.(ok ? "queued" : "queue-failed", {
        taskId,
        messageIds,
      });
      if (ok) {
        this.inFlight.set(taskId, {
          taskId,
          messageIds,
          text,
          sentAt: this.deps.now(),
          userInput: options.userInput === true,
        });
      }
      return ok;
    } finally {
      this.busy.delete(taskId);
    }
  }

  /**
   * The agent took it (a prompt boundary or a 7501 `working` for the
   * task): its messages are claimed (none left when the agent's own hook
   * claimed them already) and the entry is done.
   */
  async confirm(taskId: string): Promise<void> {
    const entry = this.inFlight.get(taskId);
    if (!entry) return;
    this.inFlight.delete(taskId);
    const claimed =
      entry.messageIds.length > 0
        ? await this.deps.claim(taskId, entry.messageIds).catch(() => 0)
        : 0;
    this.deps.onEvent?.("confirmed", { taskId, claimed });
  }

  /**
   * Overdue deliveries whose agent is at its prompt are typed instead
   * (after claiming their messages; a message someone else delivered in
   * the meantime is not typed again). A task whose pane is gone drops its
   * entry: the messages stay pending for the wake path.
   */
  async tick(state: (taskId: string) => { pane: boolean; atPrompt: boolean }) {
    const now = this.deps.now();
    const runs: Promise<void>[] = [];
    for (const [taskId, entry] of this.inFlight) {
      const { pane, atPrompt } = state(taskId);
      if (!pane) {
        this.inFlight.delete(taskId);
        this.deps.onEvent?.("dropped", { taskId, reason: "no pane" });
        continue;
      }
      if (now - entry.sentAt < QUEUE_CONFIRM_MS || !atPrompt) continue;
      this.inFlight.delete(taskId);
      runs.push(
        (async () => {
          const claimed =
            entry.messageIds.length > 0
              ? await this.deps.claim(taskId, entry.messageIds).catch(() => 0)
              : 1;
          if (claimed === 0) {
            this.deps.onEvent?.("fallback-skipped", { taskId });
            return;
          }
          const typed = await this.deps.type(taskId, entry.text);
          if (typed && entry.userInput) this.deps.recordUserInput(taskId);
          this.deps.onEvent?.("fallback-typed", { taskId, typed });
        })(),
      );
    }
    await Promise.all(runs);
  }
}
