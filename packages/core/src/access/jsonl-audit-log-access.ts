// Resource Access: the rules audit log, `<stateDir>/events/YYYY-MM-DD.jsonl`
// (one JSON entry per line, UTC day of the entry's `at`). Append-only;
// files older than the retention window are pruned on the first append of
// a new day.

import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEntry, AuditLogAccess } from "../contracts/rules.js";

const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class JsonlAuditLogAccess implements AuditLogAccess {
  private lastPrunedDay: string | undefined;

  constructor(
    private readonly dir: string,
    private readonly retentionDays = 30,
  ) {}

  async append(entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const byDay = new Map<string, string[]>();
    for (const entry of entries) {
      const day = entry.at.slice(0, 10);
      const lines = byDay.get(day) ?? [];
      lines.push(JSON.stringify(entry));
      byDay.set(day, lines);
    }
    for (const [day, lines] of byDay) {
      await appendFile(
        join(this.dir, `${day}.jsonl`),
        `${lines.join("\n")}\n`,
        {
          mode: 0o600,
        },
      );
    }
    const today = [...byDay.keys()].sort().at(-1);
    if (today && today !== this.lastPrunedDay) {
      this.lastPrunedDay = today;
      await this.prune(today).catch(() => {});
    }
  }

  async read(since?: string): Promise<AuditEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sinceDay = since?.slice(0, 10);
    const days = names
      .map((name) => name.match(FILE_PATTERN)?.[1])
      .filter((day): day is string => Boolean(day))
      .filter((day) => !sinceDay || day >= sinceDay)
      .sort();
    const entries: AuditEntry[] = [];
    for (const day of days) {
      const text = await readFile(join(this.dir, `${day}.jsonl`), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as AuditEntry;
          if (!since || entry.at >= since) entries.push(entry);
        } catch {
          // A torn last line (crash mid-append) is skipped, never fatal.
        }
      }
    }
    return entries;
  }

  private async prune(today: string): Promise<void> {
    const cutoff = new Date(
      Date.parse(`${today}T00:00:00Z`) - this.retentionDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    for (const name of await readdir(this.dir)) {
      const day = name.match(FILE_PATTERN)?.[1];
      if (day && day < cutoff) await rm(join(this.dir, name), { force: true });
    }
  }
}
