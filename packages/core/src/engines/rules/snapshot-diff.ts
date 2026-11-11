// Engine: turn a source's new snapshot into events by diffing it against
// the persisted previous one. A new subject → `<source>.<entity>.appeared`
// (data: facts), a vanished one → `.disappeared` (data: last facts), and
// each changed field → `<source>.<entity>.<field>Changed` ({ from, to }).
// Stale subjects (the source could not observe them) keep their previous
// facts and emit nothing. Pure: ids and time are injected.

import type {
  CloudEvent,
  Snapshot,
  SourceState,
} from "../../contracts/rules.js";

export interface SnapshotDiff {
  events: CloudEvent[];
  /** The subjects map to persist. */
  subjects: SourceState["subjects"];
}

export function diffSnapshots(
  sourceId: string,
  previous: SourceState["subjects"],
  next: readonly Snapshot[],
  time: string,
  nextId: () => string,
): SnapshotDiff {
  const events: CloudEvent[] = [];
  const subjects: SourceState["subjects"] = {};
  const event = (
    entity: string,
    suffix: string,
    subject: string,
    data: unknown,
  ): CloudEvent => ({
    specversion: "1.0",
    id: nextId(),
    source: sourceId,
    type: `${sourceId}.${entity}.${suffix}`,
    subject,
    time,
    datacontenttype: "application/json",
    data,
  });

  for (const snapshot of next) {
    const before = previous[snapshot.subject];
    if (snapshot.stale) {
      if (before) subjects[snapshot.subject] = before;
      continue;
    }
    const facts = normalizeFacts(snapshot.facts);
    subjects[snapshot.subject] = { entity: snapshot.entity, facts };
    if (!before) {
      events.push(event(snapshot.entity, "appeared", snapshot.subject, facts));
      continue;
    }
    const keys = new Set([...Object.keys(before.facts), ...Object.keys(facts)]);
    for (const key of keys) {
      const from = before.facts[key] ?? null;
      const to = facts[key] ?? null;
      if (!sameValue(from, to)) {
        events.push(
          event(snapshot.entity, `${key}Changed`, snapshot.subject, {
            from,
            to,
          }),
        );
      }
    }
  }
  const present = new Set(next.map((snapshot) => snapshot.subject));
  for (const [subject, before] of Object.entries(previous)) {
    if (present.has(subject)) continue;
    events.push(event(before.entity, "disappeared", subject, before.facts));
  }
  return { events, subjects };
}

/** JSON round-trip: undefined fields dropped, dates as strings. */
function normalizeFacts(
  facts: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(facts ?? {})) as Record<string, unknown>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `task/<id>` → `<id>`; anything else → undefined. */
export function taskIdOfSubject(
  subject: string | undefined,
): string | undefined {
  return subject?.startsWith("task/") ? subject.slice(5) : undefined;
}

/** The subject for a task-bound event. */
export function taskSubject(taskId: string): string {
  return `task/${taskId}`;
}
