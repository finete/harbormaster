// Resource Access: one JSON file per task under the presence directory.
// Ported from pi-home's src/access/session-presence-access.ts with the
// cmux location field dropped. Presence is ephemeral runtime data with one
// writer per task (the live process), so it stays out of the durable task
// store: registrations atomically replace the file, and mutations from a
// superseded process are ignored via pid checks.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PresenceRecord } from "../contracts/model.js";
import type {
  PresenceAccess,
  RegisterPresenceInput,
} from "../contracts/services.js";
import { readJson, writeJsonAtomic } from "../utilities/atomic-json.js";

export class SessionPresenceAccess implements PresenceAccess {
  // Mutations are read-modify-write on the same file; an interleaved
  // heartbeat read can resurrect a stale runningTurn for a whole turn, so
  // serialize them.
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const next = this.writes.then(job, job);
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private pathFor(taskId: string): string {
    // Task ids are UUIDs, but never trust a path component.
    return join(
      this.root,
      `${taskId.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.json`,
    );
  }

  register(input: RegisterPresenceInput): Promise<void> {
    return this.serialize(() => this.writeRegistration(input));
  }

  private async writeRegistration(input: RegisterPresenceInput): Promise<void> {
    const record: PresenceRecord = {
      taskId: input.taskId,
      sessionPath: input.sessionPath,
      pid: input.pid,
      mode: input.mode,
      startedAt: input.at,
      heartbeatAt: input.at,
      ...(input.logPath ? { logPath: input.logPath } : {}),
      // Headless boots straight into its single turn; an interactive session
      // starts idle (waiting for you) until its first turn begins.
      runningTurn: input.mode === "headless",
    };
    await writeJsonAtomic(this.pathFor(input.taskId), record);
  }

  async heartbeat(taskId: string, pid: number, at: string): Promise<void> {
    await this.mutate(taskId, pid, (record) =>
      record.ended ? undefined : { ...record, heartbeatAt: at },
    );
  }

  async setTurnActive(
    taskId: string,
    pid: number,
    running: boolean,
    at: string,
  ): Promise<void> {
    // A turn boundary also refreshes the heartbeat: it proves liveness.
    await this.mutate(taskId, pid, (record) =>
      record.ended
        ? undefined
        : { ...record, runningTurn: running, heartbeatAt: at },
    );
  }

  async reportOutcome(
    taskId: string,
    pid: number,
    status: "done" | "blocked",
    note: string | undefined,
    at: string,
  ): Promise<void> {
    await this.mutate(taskId, pid, (record) => ({
      ...record,
      heartbeatAt: at,
      ended: { status, ...(note ? { note } : {}), at },
    }));
  }

  end(taskId: string, pid: number, at: string): Promise<void> {
    return this.serialize(() => this.writeEnd(taskId, pid, at));
  }

  private async writeEnd(
    taskId: string,
    pid: number,
    at: string,
  ): Promise<void> {
    const record = await this.read(taskId);
    if (!record || record.pid !== pid) return; // a newer attachment took over
    if (record.mode === "interactive") {
      // The user was present; an ended interactive attachment leaves no marker.
      await rm(this.pathFor(taskId), { force: true });
      return;
    }
    if (record.ended) return; // reported outcome survives shutdown
    await writeJsonAtomic(this.pathFor(taskId), {
      ...record,
      ended: { status: "unreported", at },
    } satisfies PresenceRecord);
  }

  async read(taskId: string): Promise<PresenceRecord | undefined> {
    const record = await readJson<PresenceRecord | undefined>(
      this.pathFor(taskId),
      () => undefined,
    );
    return record &&
      typeof record.taskId === "string" &&
      typeof record.heartbeatAt === "string"
      ? record
      : undefined;
  }

  async list(): Promise<PresenceRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          readJson<PresenceRecord | undefined>(
            join(this.root, name),
            () => undefined,
          ),
        ),
    );
    return records.filter(
      (record): record is PresenceRecord =>
        !!record &&
        typeof record.taskId === "string" &&
        typeof record.heartbeatAt === "string",
    );
  }

  /** Card opened: an ended outcome has been seen and its marker is cleared. */
  acknowledge(taskId: string): Promise<void> {
    return this.serialize(async () => {
      const record = await this.read(taskId);
      if (record?.ended) await rm(this.pathFor(taskId), { force: true });
    });
  }

  clear(taskId: string): Promise<void> {
    return this.serialize(() => rm(this.pathFor(taskId), { force: true }));
  }

  markNotified(taskId: string): Promise<void> {
    return this.serialize(async () => {
      const record = await this.read(taskId);
      if (record?.ended && !record.ended.notified) {
        await writeJsonAtomic(this.pathFor(taskId), {
          ...record,
          ended: { ...record.ended, notified: true },
        } satisfies PresenceRecord);
      }
    });
  }

  private mutate(
    taskId: string,
    pid: number,
    change: (record: PresenceRecord) => PresenceRecord | undefined,
  ): Promise<void> {
    return this.serialize(async () => {
      const record = await this.read(taskId);
      if (!record || record.pid !== pid) return; // stale writer: a newer attachment owns the file
      const next = change(record);
      if (next) await writeJsonAtomic(this.pathFor(taskId), next);
    });
  }
}
