// How the Review button's `/plannotator-review` reaches the agent
// (docs/plannotator.md "Transport" → "Review button"). A slash command only
// runs when it is typed at the agent's prompt: inbox delivery (Pi's
// extension, Claude's hooks) lands as context, and Claude's hooks only fire
// while it works, so a review sent that way to an idle Claude never
// started. Main is the pty owner, so it types the command into the task's
// primary pty when the agent is provably at its prompt; otherwise it queues
// it as a user steer and types it once the agent settles. Core only builds
// the command (and records the queued message); it never touches a pty.
// Pure decision + a small queue with injected effects (tests/review-transport.test.ts).

import type { CorroboratedPresence } from "./presence-corroboration";
import { stripAnsi } from "./pty-log";

/**
 * - `type`: write the command into the primary pty now.
 * - `queue`: record it as a user steer; type it when the agent is at its
 *   prompt again (claiming the message first), unless the agent's own inbox
 *   delivery got it.
 * - `message`: no primary pty of ours: inbox delivery only (as before).
 */
export type ReviewTransport = "type" | "queue" | "message";

/** What the renderer is told: drives the review tab's placeholder. */
export type ReviewDelivery = "typed" | "queued" | "message";

/** The presence fields the decision reads (a pushed badge or a fresh corroboration). */
export type ReviewPresence = Pick<
  CorroboratedPresence,
  "live" | "runningTurn" | "corroboration" | "status"
>;

/**
 * Whether the agent itself is at its prompt, so typed text lands in its
 * input line: the presence record is the pane's own process (not a stale or
 * foreign record, nor a sub-shell), it is live, not mid-turn, and it last
 * reported a resting state. `blocked` (a permission prompt, a question) and
 * no status at all are "unsure": never typed into.
 */
export function agentAtPrompt(presence: ReviewPresence | undefined): boolean {
  if (presence?.corroboration !== "record") return false;
  if (!presence.live || presence.runningTurn) return false;
  const state = presence.status?.state;
  return state === "idle" || state === "done" || state === "error";
}

/** The rule for one Review click (or one retry of a queued one). */
export function decideReviewTransport(input: {
  /** The task has a live primary pty of ours (with or without a pane showing it). */
  pane: boolean;
  /** Corroborated presence for the task (see presence-corroboration.ts). */
  presence: ReviewPresence | undefined;
}): ReviewTransport {
  if (!input.pane) return "message";
  return agentAtPrompt(input.presence) ? "type" : "queue";
}

/**
 * Gap between the command text and its Enter. TUIs read a single chunk
 * ending in "\r" as a paste (the Enter becomes a newline in the input), so
 * the Enter goes as its own keystroke, like a person typing.
 */
export const TYPE_ENTER_DELAY_MS = 150;

/**
 * Types `command` + Enter into the task's primary pty through `write`
 * (false once the pty is gone). Resolves whether both writes landed.
 */
export async function typeCommand(
  write: (data: string) => boolean,
  command: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  if (!write(command)) return false;
  await sleep(TYPE_ENTER_DELAY_MS);
  return write("\r");
}

/**
 * The text main types for `command`. A Codex skill mention (`$name`) on
 * its own opens Codex's completion popup, where Enter only inserts the
 * skill; a trailing space closes the popup so Enter submits (verified on
 * codex-cli 0.169.0). Every other command is typed as-is.
 */
export function typedCommandText(command: string): string {
  return /^\$[A-Za-z0-9_-]+$/.test(command) ? `${command} ` : command;
}

/**
 * Types free text + Enter (the queued-delivery fallback): a multi-line text
 * goes as one bracketed paste, so its newlines stay in the input instead of
 * submitting each line.
 */
export async function typeText(
  write: (data: string) => boolean,
  text: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const body = /[\r\n]/.test(text)
    ? `\x1b[200~${text}\x1b[201~`
    : typedCommandText(text);
  if (!write(body)) return false;
  await sleep(TYPE_ENTER_DELAY_MS);
  return write("\r");
}

export interface QueuedReviewDeps {
  /** Claims exactly this message for the app (core `claimInboxMessages` with `messageIds`); whether it was still pending. */
  claim(taskId: string, messageId: string): Promise<boolean>;
  /** Types the command into the task's primary pty; whether it landed. */
  type(taskId: string, command: string): Promise<boolean>;
  onError?(taskId: string, error: unknown): void;
}

/**
 * Queued Review clicks, one per task (a newer click replaces the older
 * entry; the older message stays in the inbox for the agent). `retry` runs
 * on every presence tick: a task whose agent is at its prompt again gets
 * its message claimed and typed; one with no pty left is handed to inbox
 * delivery for good; a message the agent's own delivery already claimed
 * is dropped.
 */
export class QueuedReviews {
  private readonly queued = new Map<
    string,
    { messageId: string; command: string }
  >();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: QueuedReviewDeps) {}

  add(taskId: string, messageId: string, command: string): void {
    this.queued.set(taskId, { messageId, command });
  }

  has(taskId: string): boolean {
    return this.queued.has(taskId);
  }

  async retry(
    state: (taskId: string) => {
      pane: boolean;
      presence: ReviewPresence | undefined;
    },
  ): Promise<void> {
    const runs: Promise<void>[] = [];
    for (const [taskId, entry] of this.queued) {
      if (this.inFlight.has(taskId)) continue;
      const transport = decideReviewTransport(state(taskId));
      if (transport === "queue") continue;
      this.queued.delete(taskId);
      if (transport === "message") continue;
      this.inFlight.add(taskId);
      runs.push(
        (async () => {
          try {
            if (await this.deps.claim(taskId, entry.messageId)) {
              await this.deps.type(taskId, entry.command);
            }
          } catch (error) {
            this.deps.onError?.(taskId, error);
          } finally {
            this.inFlight.delete(taskId);
          }
        })(),
      );
    }
    await Promise.all(runs);
  }
}

// --- did the agent accept the typed command? ---------------------------------

/**
 * How long after typing the command main watches the pty for the agent
 * rejecting it. Rejection is printed right after Enter; a review that
 * starts is reported by `task-url-opened` instead.
 */
export const REVIEW_REJECT_WATCH_MS = 15_000;

/** Normalized text kept across chunks so a message split between reads still matches. */
const REJECT_CARRY = 400;

/**
 * Feeds raw pty output after the command was typed; true once the agent
 * said it does not know the command. Observed (Claude Code 2.1.325, no
 * Plannotator skills): `Unknown command: /plannotator-review` (then `Args
 * from unknown skill: …`). Matched with whitespace and terminal escapes
 * removed (TUIs move the cursor instead of printing spaces), case-folded.
 * Only a slash command can be rejected this way; any other command never
 * matches.
 */
export function createCommandRejectedMatcher(
  command: string,
): (chunk: string) => boolean {
  const name = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!name.startsWith("/")) return () => false;
  const needles = [
    `unknowncommand:${name}`,
    `unknownslashcommand:${name}`,
    `unknowncommand${name}`,
  ];
  let carry = "";
  return (chunk) => {
    const text = (carry + stripAnsi(chunk).replace(/\s+/g, "")).toLowerCase();
    carry = text.slice(-REJECT_CARRY);
    return needles.some((needle) => text.includes(needle));
  };
}
