// Status dialect replay (docs/harness-additions.md S1/S2): every fixture
// recorded from a real CLI by scripts/record-harness-status.mjs
// (tests/fixtures/status/<harness>/<version>/<scenario>.txt, raw pty
// bytes) goes through the real `ProgramStatusParser` and then the
// adapter's `interpretProgramStatus`, exactly as the app's pty layer and
// core's `reportPresence` do. The expected state sequence lives in the
// sibling .json, so a re-recording that changes behavior is a reviewed diff.
//
// A harness that reports through hooks (Cursor, `status.protocol: "hooks"`)
// emits nothing on its pty: its fixture's sequence is the recorded hook
// events (`hooks` in the .json), replayed through the adapter's event map
// (`cursorHookPresenceEvent`) and core's hook→presence rule
// (`hookPresenceReading`), from the launcher's `working` "Starting…".

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  HarnessAdapter,
  ProgramStatusReading,
} from "../src/contracts/harness.js";
import { HOOK_PRESENCE_STARTING } from "../src/contracts/harness.js";
import { CLAUDE_AWAITED_BACKGROUND } from "../src/harness/claude-code-adapter.js";
import {
  type CursorHookEventName,
  cursorHookPresenceEvent,
} from "../src/harness/cursor-adapter.js";
import { hookPresenceReading } from "../src/harness/hook-presence.js";
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
  /** Hooks-reporting harnesses: the hook events, in order. */
  hooks?: HookEvent[];
  notes: string[];
  expected: { states: string[]; final?: ProgramStatusReading };
}

interface HookEvent {
  event: CursorHookEventName;
  ms: number;
  payload: Record<string, unknown>;
  reply: Record<string, unknown>;
}

/** What core records from a hooks-reporting harness's events (presence starts `working` "Starting…"). */
function replayHooks(hooks: readonly HookEvent[]): ProgramStatusReading[] {
  let status: ProgramStatusReading = {
    state: "working",
    message: HOOK_PRESENCE_STARTING,
  };
  let aborted: string | undefined;
  const readings: ProgramStatusReading[] = [];
  for (const hook of hooks) {
    const event = cursorHookPresenceEvent(
      hook.event,
      typeof hook.reply.followup_message === "string",
    );
    const status_ =
      typeof hook.payload.status === "string" ? hook.payload.status : undefined;
    const generation =
      typeof hook.payload.generation_id === "string"
        ? hook.payload.generation_id
        : undefined;
    const report = {
      event,
      ...(event === "stop" && status_ ? { status: status_ } : {}),
      ...(generation ? { generation } : {}),
    };
    const reading = hookPresenceReading({ ...status, at: "" }, report, aborted);
    if (event === "stop" && status_ === "aborted") aborted = generation;
    if (reading) {
      status = reading;
      readings.push(reading);
    }
  }
  return readings;
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
  expect(recorded("codex")).toEqual(
    expect.arrayContaining([
      "startup",
      "turn",
      "turn-tool",
      "permission",
      "cancel",
      "background-work",
      "exit",
    ]),
  );
  expect(recorded("cursor")).toEqual(
    expect.arrayContaining([
      "startup",
      "turn",
      "turn-tool",
      "cancel",
      "background-work",
      "exit",
    ]),
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
    const hooks = adapter.capabilities.status.protocol === "hooks";
    if (hooks) {
      // Nothing on the pty; the hooks are the sequence.
      expect(parse(raw)).toEqual([]);
      expect(meta.hooks?.length ?? 0).toBeGreaterThan(0);
    }
    const readings = hooks
      ? replayHooks(meta.hooks ?? [])
      : interpret(adapter, parse(raw));
    expect(collapse(readings)).toEqual(meta.expected.states);
    if (meta.expected.final) {
      expect(readings.at(-1)).toEqual(meta.expected.final);
    }
    // No recorded scenario leaves a task spinning: every one ends at rest.
    expect(readings.at(-1)?.state).not.toBe("working");
  });
});

describe("scenario semantics", () => {
  it("a Claude, Pi, Codex and Cursor turn ends in done", () => {
    for (const harness of ["claude-code", "pi", "codex", "cursor"]) {
      const { meta } = fixture(harness, "turn");
      expect(meta.expected.states.at(-1), harness).toBe("done");
      expect(meta.expected.states, harness).toContain("working");
    }
  });

  it("Esc cancel ends idle (not done, not working) for all", () => {
    for (const harness of ["claude-code", "pi", "codex", "cursor"]) {
      const { meta } = fixture(harness, "cancel");
      expect(meta.expected.states, harness).toContain("working");
      expect(meta.expected.states.at(-1), harness).toBe("idle");
    }
  });

  it("startup settles idle", () => {
    for (const harness of ["claude-code", "pi", "codex", "cursor"]) {
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

  it("Codex reports without the probe and blips idle→working→idle at startup (X4)", () => {
    const { meta, raw } = fixture("codex", "startup");
    expect(raw).not.toContain("\x1b]7501;?");
    expect(meta.expected.states).toEqual(["idle", "working", "idle"]);
  });

  it("Codex: blocked carries no message; declining (Esc) ends idle", () => {
    const reports = parse(fixture("codex", "permission").raw);
    const blocked = reports.filter((report) => report.state === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    for (const report of blocked) {
      expect(report.message).toBeUndefined();
      expect(report.kind).toBe("permission");
    }
    expect(reports.at(-1)?.state).toBe("idle");
  });

  it("Codex: the reply arrives as OSC 9 right before done; background work still ends in done", () => {
    for (const scenario of ["turn", "background-work"]) {
      const { raw } = fixture("codex", scenario);
      const done = raw.lastIndexOf("\x1b]7501;state=done");
      const note = raw.lastIndexOf("\x1b]9;", done);
      expect(done, scenario).toBeGreaterThan(0);
      expect(note, scenario).toBeGreaterThan(0);
      // Nothing but the OSC 9 sequence sits between them.
      const between = raw.slice(note, done);
      expect(between, scenario).toMatch(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 9 framing
        /^\x1b\]9;[^\x07\x1b]*(\x07|\x1b\\)$/,
      );
      expect(parse(raw).at(-1)?.state, scenario).toBe("done");
    }
    expect(fixture("codex", "turn").raw).toContain("\x1b]9;OK");
  });

  it("Cursor: Esc fires stop 'aborted' then 'error' for the same generation, recorded idle (no warning)", () => {
    const { meta } = fixture("cursor", "cancel");
    const stops = (meta.hooks ?? []).filter((hook) => hook.event === "stop");
    expect(stops.map((hook) => hook.payload.status)).toEqual([
      "aborted",
      "error",
    ]);
    expect(stops[0]?.payload.generation_id).toBe(
      stops[1]?.payload.generation_id,
    );
    expect(meta.expected.final).toEqual({ state: "idle" });
  });

  it("Cursor: the stop payload carries per-turn tokens; the transcript path is null at sessionStart", () => {
    const { meta } = fixture("cursor", "turn");
    const start = meta.hooks?.find((hook) => hook.event === "session-start");
    expect(start?.payload.transcript_path).toBeNull();
    expect(start?.payload.conversation_id).toBe(start?.payload.session_id);
    const stop = meta.hooks?.find((hook) => hook.event === "stop");
    expect(stop?.payload).toMatchObject({
      status: "completed",
      loop_count: 0,
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      cache_read_tokens: expect.any(Number),
      cache_write_tokens: expect.any(Number),
    });
    // Recordings never keep the account's e-mail.
    for (const entry of FIXTURES.filter((f) => f.meta.harness === "cursor")) {
      for (const hook of entry.meta.hooks ?? []) {
        if ("user_email" in hook.payload) {
          expect(hook.payload.user_email).toBe("<redacted>");
        }
      }
    }
  });
});
