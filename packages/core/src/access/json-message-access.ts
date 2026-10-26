// Resource Access: task-message storage (see /docs/task-messaging.md). Owns
// everything on disk for messaging so Managers and Engines never touch it:
// `<stateDir>/messages/messages.json` (the log + last user inputs) under
// `messages.lock` with atomic writes and a parse cache (same utilities as
// the task store), per-task doorbell files watched via `fs.watch` for the
// cross-process inbox signal, and the attachment copies under
// `attachments/<messageId>/`. Business verbs, not CRUD: every mutation is
// one read-modify-write under the lock, so concurrent claimers (the extension
// in several processes, the app) never see the same message twice.

import { mkdirSync, watch } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type {
  MessageAttachment,
  MessageStoreSnapshot,
  TaskMessage,
} from "../contracts/messaging.js";
import type {
  ApproveMessageInput,
  ClaimDeliverableInput,
  MessageAccess,
  RecordMessageOptions,
} from "../contracts/services.js";
import { writeJsonAtomic } from "../utilities/atomic-json.js";
import { withFileLock } from "../utilities/file-lock.js";
import { JsonFileCache } from "../utilities/json-file-cache.js";

/** Per-attachment size limit. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Attachments per message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
};

interface MessageStoreFile {
  version: 1;
  messages: TaskMessage[];
  userInputs: Record<string, string>;
}

const emptyStore = (): MessageStoreFile => ({
  version: 1,
  messages: [],
  userInputs: {},
});

/** Never trust an id or file name as a path component (same rule as the presence access; `.`/`..` are neutralized too). */
function sanitize(component: string): string {
  const safe = component.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return /^\.+$/.test(safe) || safe === ""
    ? safe.replaceAll(".", "_") || "_"
    : safe;
}

function mimeTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : MIME_TYPES[path.slice(dot + 1).toLowerCase()];
}

export interface JsonMessageAccessPaths {
  messagesFile: string;
  messagesLockFile: string;
  doorbellDir: string;
  attachmentsDir: string;
}

export class JsonMessageAccess implements MessageAccess {
  private readonly paths: JsonMessageAccessPaths;
  private readonly cache: JsonFileCache<MessageStoreFile>;

  /** `paths`: the messaging slice of `resolveStatePaths(stateDir)`. */
  constructor(paths: JsonMessageAccessPaths) {
    this.paths = paths;
    this.cache = new JsonFileCache<MessageStoreFile>(
      this.paths.messagesFile,
      emptyStore,
      (value) => this.validate(value),
    );
  }

  async readStore(): Promise<MessageStoreSnapshot> {
    const { messages, userInputs } = await this.cache.read();
    return structuredClone({ messages, userInputs });
  }

  async getMessage(id: string): Promise<TaskMessage | undefined> {
    return structuredClone(
      (await this.cache.read()).messages.find((message) => message.id === id),
    );
  }

  async listMessages(filter?: { taskId?: string }): Promise<TaskMessage[]> {
    const { messages } = await this.cache.read();
    const taskId = filter?.taskId;
    return structuredClone(
      messages.filter(
        (message) =>
          taskId === undefined ||
          message.targetTaskId === taskId ||
          (message.sender.kind === "task" && message.sender.taskId === taskId),
      ),
    );
  }

  async recordMessage(
    message: TaskMessage,
    options?: RecordMessageOptions,
  ): Promise<void> {
    await this.mutate((state) => {
      if (state.messages.some((item) => item.id === message.id))
        throw new Error(`Message already exists: ${message.id}`);
      options?.precondition?.(structuredClone(state));
      state.messages.push(structuredClone(message));
      return message.status === "pending" ? [message.targetTaskId] : [];
    });
  }

  async approveMessage(
    id: string,
    input: ApproveMessageInput,
  ): Promise<TaskMessage> {
    let result: TaskMessage | undefined;
    await this.mutate((state) => {
      const message = this.requireMessage(state, id);
      if (message.status !== "awaiting_approval")
        throw new Error(`Message ${id} is not awaiting approval.`);
      if (input.text !== undefined && input.text !== message.text) {
        message.originalText = message.text;
        message.text = input.text;
      }
      if (input.mode) message.requestedMode = input.mode;
      message.status = "pending";
      message.approvedAt = input.approvedAt;
      result = structuredClone(message);
      return [message.targetTaskId];
    });
    return result as TaskMessage;
  }

  async rejectMessage(id: string, rejectedAt: string): Promise<TaskMessage> {
    let result: TaskMessage | undefined;
    await this.mutate((state) => {
      const message = this.requireMessage(state, id);
      if (message.status !== "awaiting_approval")
        throw new Error(`Message ${id} is not awaiting approval.`);
      message.status = "rejected";
      message.rejectedAt = rejectedAt;
      result = structuredClone(message);
      return [];
    });
    return result as TaskMessage;
  }

  async failMessage(
    id: string,
    failedAt: string,
    reason: string,
  ): Promise<TaskMessage | undefined> {
    let result: TaskMessage | undefined;
    await this.mutate((state) => {
      const message = state.messages.find((item) => item.id === id);
      if (!message) return [];
      if (
        message.status === "awaiting_approval" ||
        message.status === "pending"
      ) {
        message.status = "failed";
        message.failedAt = failedAt;
        message.failureReason = reason;
      }
      result = structuredClone(message);
      return [];
    });
    return result;
  }

  async failPendingForTask(
    taskId: string,
    failedAt: string,
    reason: string,
  ): Promise<TaskMessage[]> {
    const failed: TaskMessage[] = [];
    await this.mutate((state) => {
      for (const message of state.messages) {
        if (message.status !== "pending" || message.targetTaskId !== taskId)
          continue;
        message.status = "failed";
        message.failedAt = failedAt;
        message.failureReason = reason;
        failed.push(structuredClone(message));
      }
      return [];
    });
    return failed;
  }

  async claimDeliverable(
    taskId: string,
    input: ClaimDeliverableInput,
  ): Promise<TaskMessage[]> {
    const claimed: TaskMessage[] = [];
    await this.mutate((state) => {
      const candidates = state.messages
        .filter(
          (message) =>
            message.status === "pending" && message.targetTaskId === taskId,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const message of candidates) {
        const mode = input.resolveMode(message.requestedMode);
        if (!input.idle && mode !== "steer") continue;
        message.status = "delivered";
        message.deliveredAt = input.deliveredAt;
        message.deliveredMode = mode;
        claimed.push(structuredClone(message));
      }
      return [];
    });
    return claimed;
  }

  async listPendingTargets(): Promise<string[]> {
    const { messages } = await this.cache.read();
    return [
      ...new Set(
        messages
          .filter((message) => message.status === "pending")
          .map((message) => message.targetTaskId),
      ),
    ];
  }

  async recordUserInput(taskId: string, at: string): Promise<void> {
    await this.mutate((state) => {
      state.userInputs[taskId] = at;
      return [];
    });
  }

  async markAttachmentsPruned(id: string, prunedAt: string): Promise<void> {
    await this.mutate((state) => {
      const message = state.messages.find((item) => item.id === id);
      if (!message) return [];
      for (const attachment of message.attachments) {
        attachment.prunedAt ??= prunedAt;
      }
      return [];
    });
  }

  async copyAttachments(
    messageId: string,
    paths: readonly string[],
  ): Promise<MessageAttachment[]> {
    if (paths.length === 0) return [];
    if (paths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(
        `Too many attachments (${paths.length}); the limit is ${MAX_ATTACHMENTS_PER_MESSAGE} per message.`,
      );
    }
    const sizes: number[] = [];
    for (const path of paths) {
      if (!isAbsolute(path))
        throw new Error(`Attachment path must be absolute: ${path}`);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        throw new Error(`Attachment not found: ${path}`);
      }
      if (!info.isFile())
        throw new Error(`Attachment is not a regular file: ${path}`);
      if (info.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `Attachment is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB: ${path}`,
        );
      }
      sizes.push(info.size);
    }
    const dir = this.attachmentDir(messageId);
    const copies: MessageAttachment[] = [];
    try {
      await mkdir(dir, { recursive: true });
      for (const [index, path] of paths.entries()) {
        const target = join(dir, `${index}-${sanitize(basename(path))}`);
        await copyFile(path, target);
        const mimeType = mimeTypeFor(path);
        copies.push({
          path: target,
          originalPath: path,
          ...(mimeType ? { mimeType } : {}),
          bytes: sizes[index] as number,
        });
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return copies;
  }

  async readAttachment(attachment: MessageAttachment): Promise<string> {
    const root = resolve(this.paths.attachmentsDir);
    const path = resolve(attachment.path);
    if (!path.startsWith(`${root}${sep}`))
      throw new Error("Attachment is outside the message attachment store.");
    try {
      return (await readFile(path)).toString("base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("Attachment was pruned or is missing.");
      throw error;
    }
  }

  async removeAttachments(messageId: string): Promise<void> {
    await rm(this.attachmentDir(messageId), { recursive: true, force: true });
  }

  watchDoorbell(taskId: string, listener: () => void): () => void {
    const name = sanitize(taskId);
    try {
      mkdirSync(this.paths.doorbellDir, { recursive: true });
      const watcher = watch(
        this.paths.doorbellDir,
        { persistent: false },
        (_event, filename) => {
          // Some platforms omit the file name: ring (a spurious claim is harmless).
          if (filename && String(filename) !== name) return;
          try {
            listener();
          } catch {
            /* a listener's failure must not kill the watcher */
          }
        },
      );
      watcher.on("error", () => {});
      return () => watcher.close();
    } catch {
      return () => {};
    }
  }

  private attachmentDir(messageId: string): string {
    return join(this.paths.attachmentsDir, sanitize(messageId));
  }

  private requireMessage(state: MessageStoreFile, id: string): TaskMessage {
    const message = state.messages.find((item) => item.id === id);
    if (!message) throw new Error(`Message not found: ${id}`);
    return message;
  }

  /**
   * One read-modify-write under the lock. `change` returns the task ids whose
   * deliverable inbox it changed; their doorbells ring after the write.
   */
  private async mutate(
    change: (state: MessageStoreFile) => string[],
  ): Promise<void> {
    const rung = await withFileLock(this.paths.messagesLockFile, async () => {
      const state = structuredClone(await this.cache.read());
      const ring = change(state);
      this.validate(state);
      this.cache.invalidate();
      try {
        await writeJsonAtomic(this.paths.messagesFile, state);
      } finally {
        this.cache.invalidate();
      }
      return ring;
    });
    for (const taskId of new Set(rung)) await this.ringDoorbell(taskId);
  }

  private async ringDoorbell(taskId: string): Promise<void> {
    try {
      await mkdir(this.paths.doorbellDir, { recursive: true });
      await writeFile(
        join(this.paths.doorbellDir, sanitize(taskId)),
        `${new Date().toISOString()}\n`,
      );
    } catch {
      /* the doorbell is best-effort: claimers also poll */
    }
  }

  private validate(value: unknown): asserts value is MessageStoreFile {
    const bad = () =>
      new Error(
        `Unsupported or corrupt message state at ${this.paths.messagesFile}`,
      );
    if (!isRecord(value) || value.version !== 1) throw bad();
    if (!Array.isArray(value.messages) || !isRecord(value.userInputs))
      throw bad();
    const ids = new Set<string>();
    for (const item of value.messages) {
      if (!validMessage(item) || ids.has(item.id)) throw bad();
      ids.add(item.id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const STATUSES = [
  "awaiting_approval",
  "pending",
  "delivered",
  "rejected",
  "failed",
];
const ROUTES = ["parent-to-child", "child-to-parent", "approval", "receipt"];

function validMessage(value: unknown): value is TaskMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isRecord(value.sender) &&
    typeof value.targetTaskId === "string" &&
    ROUTES.includes(value.route as string) &&
    typeof value.text === "string" &&
    (value.requestedMode === "steer" || value.requestedMode === "followUp") &&
    Array.isArray(value.attachments) &&
    STATUSES.includes(value.status as string) &&
    typeof value.createdAt === "string"
  );
}
