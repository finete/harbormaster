// Contract rows (docs/harness-additions.md P5, "Fakes replay, never
// decide"): every behavior of a harness CLI that Harbormaster relies on, as
// one row with the exact strings it involves. Three consumers:
//
// - the fake (`e2e/fake-<harness>.ts`) implements only rows, naming each
//   row it replays with `<contract>.row("<id>")` (or declaring a row it
//   deliberately does not replay with `notReplayed("<id>", reason)`);
//   `tests/fake-contract-coverage.test.ts` fails on a fake behavior without
//   a row and on a keyless row the fake never mentions;
// - the keyless real-CLI tier (`tests/real-cli-smoke.test.ts`, T3) asserts
//   every row with `needsModel: false` against the pinned binary, each
//   assertion labelled with its row id, so drift fails on the same row;
// - rows with `needsModel: true` (they need a logged-in model or the user's
//   real third-party installs) are listed by id in T3's skipped block for
//   the real smoke (T4) to pick up.
//
// Facts are plain JSON values (strings, string arrays, objects) so a fake
// can inline them into the script it writes; patterns are strings compiled
// with `new RegExp` where used.

export type ContractRowKind =
  | "argv"
  | "env"
  | "status"
  | "hook"
  | "command"
  | "session-file"
  | "prompt"
  | "trust";

/** A JSON-serializable fact (inlined into fake scripts as JSON). */
export type ContractFact =
  | string
  | number
  | boolean
  | readonly ContractFact[]
  | { readonly [key: string]: ContractFact };

export interface ContractRow {
  /** Stable id, `<harness>.<area>.<behavior>`; fakes and T3 reference it verbatim. */
  readonly id: string;
  readonly title: string;
  readonly kind: ContractRowKind;
  /**
   * True when the row cannot be checked keylessly: it needs a real model
   * turn (a login) or the user's real third-party installs (Plannotator).
   * T3 asserts every row with `false`; the real smoke (T4) covers the rest.
   */
  readonly needsModel: boolean;
  /** What the binary does, observed on the pinned version; where it matters to Harbormaster. */
  readonly detail: string;
  /** The exact strings / shapes / patterns the row relies on. */
  readonly facts: { readonly [key: string]: ContractFact };
}

export interface Contract<R extends readonly ContractRow[]> {
  /** The harness id (core's adapter id). */
  readonly harness: string;
  /** The binary version the rows were observed on (T3's pin). */
  readonly version: string;
  readonly rows: R;
  /** The row with `id`; throws on an unknown id (a typo is a failing fake, not a silent one). */
  row<I extends R[number]["id"]>(id: I): Extract<R[number], { id: I }>;
}

export function defineContract<const R extends readonly ContractRow[]>(
  harness: string,
  version: string,
  rows: R,
): Contract<R> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`duplicate contract row ${row.id}`);
    ids.add(row.id);
  }
  return {
    harness,
    version,
    rows,
    row(id) {
      const found = rows.find((row) => row.id === id);
      if (!found) throw new Error(`unknown contract row ${id}`);
      return found as never;
    },
  };
}

/**
 * Marks a keyless row a fake deliberately does not replay, with the reason
 * (an e2e that never answers the dialog, say). Counts as a reference for
 * the coverage test; returns nothing the fake could act on.
 */
export function notReplayed(_id: string, _reason: string): void {}
