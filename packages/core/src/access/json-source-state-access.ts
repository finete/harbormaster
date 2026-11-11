// Resource Access: per-source rules-engine state under `<stateDir>/sources/`
// — `<source id>.json` (last snapshot per subject, cursor, dedupe window)
// and `.pending.json` (moves to re-evaluate next tick). Written only by the
// app's refresh tick (single automation host), so no cross-process lock.

import { join } from "node:path";
import type {
  PendingRuleMove,
  SourceState,
  SourceStateAccess,
} from "../contracts/rules.js";
import { readJson, writeJsonAtomic } from "../utilities/atomic-json.js";

const PENDING_FILE = ".pending.json";

export class JsonSourceStateAccess implements SourceStateAccess {
  constructor(private readonly dir: string) {}

  async read(sourceId: string): Promise<SourceState> {
    const state = await readJson<SourceState>(this.file(sourceId), () => ({
      subjects: {},
    })).catch(() => ({ subjects: {} }) as SourceState);
    return state && typeof state.subjects === "object" && state.subjects
      ? state
      : { subjects: {} };
  }

  async write(sourceId: string, state: SourceState): Promise<void> {
    await writeJsonAtomic(this.file(sourceId), state);
  }

  async readPending(): Promise<PendingRuleMove[]> {
    const pending = await readJson<PendingRuleMove[]>(
      join(this.dir, PENDING_FILE),
      () => [],
    ).catch(() => []);
    return Array.isArray(pending) ? pending : [];
  }

  async writePending(pending: PendingRuleMove[]): Promise<void> {
    await writeJsonAtomic(join(this.dir, PENDING_FILE), pending);
  }

  private file(sourceId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId)) {
      throw new Error(`Invalid source id: ${sourceId}`);
    }
    return join(this.dir, `${sourceId}.json`);
  }
}
