// Fakes replay, never decide (docs/harness-additions.md P5): each fake
// names the contract rows it replays (`<CONTRACT>.row("<id>")`) or
// deliberately does not (`notReplayed("<id>", reason)`). This lint-style
// test fails when a fake references a row that does not exist (a behavior
// without a row), when a keyless row is never mentioned by its fake, or
// when the keyless real-CLI tier (T3) lacks an assertion for a keyless row.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CONTRACT } from "../e2e/contracts/claude-code";
import { CODEX_CONTRACT } from "../e2e/contracts/codex";
import { CURSOR_CONTRACT } from "../e2e/contracts/cursor";
import { PI_CONTRACT } from "../e2e/contracts/pi";
import type { ContractRow } from "../e2e/contracts/types";

const E2E = join(__dirname, "..", "e2e");
const T3 = readFileSync(join(__dirname, "real-cli-smoke.test.ts"), "utf8");

/** Row ids a source names via `.row("…")` / `notReplayed("…", …)`. */
function referencedIds(source: string): {
  replayed: string[];
  notReplayed: Array<{ id: string; reason: string }>;
} {
  return {
    replayed: [...source.matchAll(/\.row\(\s*"([^"]+)"\s*\)/g)].map(
      (match) => match[1] as string,
    ),
    notReplayed: [
      ...source.matchAll(/notReplayed\(\s*"([^"]+)",\s*"([^"]*)"/g),
    ].map((match) => ({
      id: match[1] as string,
      reason: match[2] as string,
    })),
  };
}

const CASES: Array<{
  fake: string;
  contract: { harness: string; rows: readonly ContractRow[] };
}> = [
  { fake: "fake-claude.ts", contract: CLAUDE_CODE_CONTRACT },
  { fake: "fake-pi.ts", contract: PI_CONTRACT },
  { fake: "fake-codex.ts", contract: CODEX_CONTRACT },
  { fake: "fake-cursor.ts", contract: CURSOR_CONTRACT },
];

describe.each(CASES)(
  "$fake replays contracts/$contract.harness",
  ({ fake, contract }) => {
    const source = readFileSync(join(E2E, fake), "utf8");
    const refs = referencedIds(source);
    const known = new Set(contract.rows.map((row) => row.id));

    it("references only rows that exist (no behavior without a row)", () => {
      const unknown = [
        ...refs.replayed,
        ...refs.notReplayed.map((entry) => entry.id),
      ].filter((id) => !known.has(id));
      expect(unknown).toEqual([]);
    });

    it("mentions every keyless row (replayed or explicitly not, with a reason)", () => {
      const mentioned = new Set([
        ...refs.replayed,
        ...refs.notReplayed.map((entry) => entry.id),
      ]);
      const missing = contract.rows
        .filter((row) => !row.needsModel && !mentioned.has(row.id))
        .map((row) => row.id);
      expect(missing).toEqual([]);
      for (const entry of refs.notReplayed) {
        expect(entry.reason.length, entry.id).toBeGreaterThan(10);
        expect(refs.replayed, entry.id).not.toContain(entry.id);
      }
    });

    it("every keyless row has a T3 assertion (real-cli-smoke.test.ts rowIt)", () => {
      const asserted = new Set(
        [...T3.matchAll(/rowIt\(\s*"([^"]+)"/g)].map((match) => match[1]),
      );
      const missing = contract.rows
        .filter((row) => !row.needsModel && !asserted.has(row.id))
        .map((row) => row.id);
      expect(missing).toEqual([]);
    });
  },
);

describe("contract tables", () => {
  it("ids are unique, prefixed by harness, and facts are JSON values", () => {
    const prefixes: Record<string, string> = {
      "claude-code": "claude.",
      pi: "pi.",
      codex: "codex.",
      cursor: "cursor.",
    };
    for (const contract of [
      CLAUDE_CODE_CONTRACT,
      PI_CONTRACT,
      CODEX_CONTRACT,
      CURSOR_CONTRACT,
    ]) {
      const prefix = prefixes[contract.harness] ?? "?";
      for (const row of contract.rows) {
        expect(row.id.startsWith(prefix), row.id).toBe(true);
        expect(JSON.parse(JSON.stringify(row.facts))).toEqual(row.facts);
      }
    }
  });

  it("T3's PINNED versions equal the contracts' versions", () => {
    expect(T3).toContain(
      `"@anthropic-ai/claude-code@${CLAUDE_CODE_CONTRACT.version}"`,
    );
    expect(T3).toContain(
      `"@earendil-works/pi-coding-agent@${PI_CONTRACT.version}"`,
    );
    expect(T3).toContain(`"@openai/codex@${CODEX_CONTRACT.version}"`);
    expect(T3).toContain(`"cursor-agent@${CURSOR_CONTRACT.version}"`);
  });
});
