// Utility: per-model token accumulation shared by the harness usage readers
// (access/*-session-usage-access.ts) and the usage engine. `cost` survives
// only when every turn added for a model carried one (a partial sum would
// under-report silently, docs/costs.md: "missing evidence stays
// unavailable, never zero").

import type { ModelUsage, TokenBuckets } from "../contracts/usage.js";

export function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function totalTokens(buckets: TokenBuckets): number {
  return (
    buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite
  );
}

/** A non-negative finite number, else 0 (transcripts are untrusted input). */
export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

interface Slot extends TokenBuckets {
  turns: number;
  cost: number;
  /** Every turn so far had a cost. */
  priced: boolean;
}

export class ModelUsageAccumulator {
  private readonly slots = new Map<string, Slot>();

  /** Add one assistant turn (or `turns` of them, when merging aggregates). */
  add(
    model: string,
    buckets: TokenBuckets,
    cost: number | undefined,
    turns = 1,
  ): void {
    let slot = this.slots.get(model);
    if (!slot) {
      slot = { ...emptyBuckets(), turns: 0, cost: 0, priced: true };
      this.slots.set(model, slot);
    }
    slot.input += buckets.input;
    slot.output += buckets.output;
    slot.cacheRead += buckets.cacheRead;
    slot.cacheWrite += buckets.cacheWrite;
    slot.turns += turns;
    if (cost === undefined || !Number.isFinite(cost)) slot.priced = false;
    else slot.cost += cost;
  }

  /** Merge an aggregated `ModelUsage`. */
  addUsage(usage: ModelUsage): void {
    this.add(usage.model, usage, usage.cost, usage.turns);
  }

  get size(): number {
    return this.slots.size;
  }

  /** Per model, most tokens first (ties by model id). */
  result(): ModelUsage[] {
    return [...this.slots.entries()]
      .map(
        ([model, slot]): ModelUsage => ({
          model,
          input: slot.input,
          output: slot.output,
          cacheRead: slot.cacheRead,
          cacheWrite: slot.cacheWrite,
          turns: slot.turns,
          ...(slot.priced && slot.turns > 0
            ? { cost: roundCost(slot.cost) }
            : {}),
        }),
      )
      .sort(
        (a, b) =>
          totalTokens(b) - totalTokens(a) || a.model.localeCompare(b.model),
      );
  }
}

/** Float noise off a summed USD figure (micro-dollar precision). */
export function roundCost(cost: number): number {
  return Math.round(cost * 1e6) / 1e6;
}
