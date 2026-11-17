// Status dialect replay (docs/harness-additions.md S1/S2): every fixture
// recorded from a real CLI by scripts/record-harness-status.mjs
// (tests/fixtures/status/<harness>/<version>/<scenario>.txt, raw pty
// bytes) goes through the real `ProgramStatusParser` and then the
// adapter's `interpretProgramStatus`, exactly as the app's pty layer and
// core's `reportPresence` do. The expected state sequence lives in the
// sibling .json, so a re-recording that changes behavior is a reviewed diff.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  HarnessAdapter,
  ProgramStatusReading,
} from "../src/contracts/harness.js";
import { CLAUDE_AWAITED_BACKGROUND } from "../src/harness/claude-code-adapter.js";
import { createHarnessRegistry } from "../src/harness/registry.js";
import {
  ProgramStatusParser,
  type ProgramStatusReport,
} from "../src/utilities/program-status.js";

const ROOT = join(import.meta.dirname, "fixtures", "status");

interface FixtureMeta {
  harness: string;
  version: string;
  scenario: string;
  recordedAt: string;
  prompts: string[];
  reports: Array<ProgramStatusReport & { ms: number }>;
  notes: string[];
  expected: { states: string[]; final?: ProgramStatusReading };
}

interface Fixture {
  meta: FixtureMeta;
  raw: string;
}

function loadFixtures(): Fixture[] {
  if (!existsSync(ROOT)) return [];
  const fixtures: Fixture[] = [];
  for (const harness of readdirSync(ROOT)) {
    for (const version of readdirSync(join(ROOT, harness))) {
      const dir = join(ROOT, harness, version);
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const meta = JSON.parse(
          readFileSync(join(dir, file), "utf8"),
        ) as FixtureMeta;
        const raw = readFileSync(
          join(dir, file.replace(/\.json$/, ".txt")),
          "utf8",
        );
        fixtures.push({ meta, raw });
      }
    }
  }
  return fixtures;
}

const FIXTURES = loadFixtures();
const registry = createHarnessRegistry();

/** The raw stream through the parser, fed in pty-sized chunks (sequences split across chunks). */
function parse(raw: string, chunk = 512): ProgramStatusReport[] {
  const parser = new ProgramStatusParser();
  const reports: ProgramStatusReport[] = [];
  for (let at = 0; at < raw.length; at += chunk) {
    reports.push(...parser.feed(raw.slice(at, at + chunk)).reports);
  }
  return reports;
}

/** What core records per report (before any hook turn boundary). */
function interpret(
  adapter: HarnessAdapter,
  reports: ProgramStatusReport[],
): ProgramStatusReading[] {
  return reports.map((report) => {
    const reading: ProgramStatusReading = {
      state: report.state,
      ...(report.message ? { message: report.message } : {}),
    };
    return adapter.interpretProgramStatus?.(reading) ?? reading;
  });
}

function collapse(readings: ProgramStatusReading[]): string[] {
  const states: string[] = [];
  for (const { state } of readings) {
    if (states.at(-1) !== state) states.push(state);
  }
  return states;
}

function fixture(harness: string, scenario: string): Fixture {
  const found = FIXTURES.find(
    (entry) =>
      entry.meta.harness === harness && entry.meta.scenario === scenario,
  );
  if (!found) throw new Error(`no ${harness} ${scenario} fixture`);
  return found;
}

it("has the required recordings (S1)", () => {
  const recorded = (harness: string) =>
    FIXTURES.filter((f) => f.meta.harness === harness).map(
      (f) => f.meta.scenario,
    );
  expect(recorded("claude-code")).toEqual(
    expect.arrayContaining(["startup", "turn", "background-work", "cancel"]),
  );
  expect(recorded("pi")).toEqual(
    expect.arrayContaining(["startup", "turn", "cancel"]),
  );
});

describe.each(
  FIXTURES.map((entry) => ({
    name: `${entry.meta.harness} ${entry.meta.version} ${entry.meta.scenario}`,
    entry,
  })),
)("replay: $name", ({ entry }) => {
  const { meta, raw } = entry;
  const adapter = registry.get(meta.harness);

  it("is a registered harness, recorded under its own path", () => {
    expect(adapter).toBeDefined();
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(200 * 1024);
  });

  it("parses to the reports recorded alongside it", () => {
    const reports = parse(raw);
    expect(reports).toEqual(
      meta.reports.map(({ ms: _ms, ...report }) => report),
    );
    // Chunking never changes what the parser sees.
    expect(parse(raw, 7)).toEqual(reports);
  });

  it("interprets to the expected state sequence", () => {
    if (!adapter) return;
    const readings = interpret(adapter, parse(raw));
    expect(collapse(readings)).toEqual(meta.expected.states);
    if (meta.expected.final) {
      expect(readings.at(-1)).toEqual(meta.expected.final);
    }
    // No recorded scenario leaves a task spinning: every one ends at rest.
    expect(readings.at(-1)?.state).not.toBe("working");
  });
});

describe("scenario semantics", () => {
  it("a Claude turn ends in done; a Pi turn ends in done", () => {
    for (const harness of ["claude-code", "pi"]) {
      const { meta } = fixture(harness, "turn");
      expect(meta.expected.states.at(-1), harness).toBe("done");
      expect(meta.expected.states, harness).toContain("working");
    }
  });

  it("Esc cancel ends idle (not done, not working) for both", () => {
    for (const harness of ["claude-code", "pi"]) {
      const { meta } = fixture(harness, "cancel");
      expect(meta.expected.states, harness).toContain("working");
      expect(meta.expected.states.at(-1), harness).toBe("idle");
    }
  });

  it("startup settles idle", () => {
    for (const harness of ["claude-code", "pi"]) {
      expect(fixture(harness, "startup").meta.expected.states.at(-1)).toBe(
        "idle",
      );
    }
  });

  it("Claude background-work: the real 'still running' report matches the 96c2985 regex and is recorded as idle", () => {
    const { meta, raw } = fixture("claude-code", "background-work");
    const reports = parse(raw);
    const lingering = reports.filter(
      (report) =>
        report.state === "working" &&
        report.message !== undefined &&
        /still running/.test(report.message),
    );
    expect(lingering.length).toBeGreaterThan(0);
    for (const report of lingering) {
      expect(report.message?.trim()).toMatch(CLAUDE_AWAITED_BACKGROUND);
    }
    expect(meta.expected.final).toMatchObject({
      state: "idle",
      message: expect.stringMatching(/still running/),
    });
    // Without the adapter's interpretation it would spin forever.
    expect(reports.at(-1)?.state).toBe("working");
  });

  it("Pi background-work needs no interpretation: it reports done itself", () => {
    const entry = FIXTURES.find(
      (f) => f.meta.harness === "pi" && f.meta.scenario === "background-work",
    );
    if (!entry) return;
    expect(parse(entry.raw).at(-1)?.state).toBe("done");
  });
});
