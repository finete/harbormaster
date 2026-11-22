// Every supported harness's real output through main's real pty pipeline
// (docs/harness-additions.md "Recorded output fixtures"). The fixtures are
// raw pty bytes recorded from the pinned CLIs by
// scripts/record-harness-status.mjs (packages/core/tests/fixtures/status/
// <harness>/<version>/), including `long-output`: a long reply plus
// scrolling, which is where each TUI's redraw style shows (Pi's fullscreen
// UI never prints a newline). Here they are `cat`ed through a task-primary
// pty session (`createSession`), so every per-chunk step main runs on
// agent output (traffic accounting, the output tail, the Plannotator
// ready-line watcher, the 7501 status filter, the mode tracker, the
// batcher) sees them in real pty-sized chunks.
//
// The property: cost stays linear in output size. Growing the replay 4x
// must cost ~4x, never ~16x. The 2026-11-19 scroll-lag bug (an output tail
// re-stripping everything a Pi pane ever drew, per chunk) fails this.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessRegistry } from "@harbormaster/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  acknowledgeSessionData,
  createSession,
  disposeSession,
} from "../src/main/ptySessions";

const FIXTURES = join(
  __dirname,
  "..",
  "..",
  "core",
  "tests",
  "fixtures",
  "status",
);
const SMALL_BYTES = 4 * 1024 * 1024;
const GROWTH = 4;
/** Linear is ~GROWTH; quadratic is ~GROWTH². */
const MAX_RATIO = 7;

const HARNESSES = createHarnessRegistry({})
  .list()
  .map((adapter) => adapter.descriptor.id);

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest recorded version's directory for a harness. */
function newestFixtureDir(harness: string): string | undefined {
  const root = join(FIXTURES, harness);
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root).sort(compareVersions);
  const newest = versions.at(-1);
  return newest ? join(root, newest) : undefined;
}

const temp = mkdtempSync(join(tmpdir(), "hm-pty-replay-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/**
 * Printed after the last copy. The replay ends when it comes out, not on
 * the process's exit: on Linux, node-pty sometimes never delivers the last
 * read when the child exits (ubuntu CI: 22 of 23 raw chunks arrived, the
 * final ~3.8 KB never did), which failed the intact check. The shell stays
 * alive until the test disposes the session, so nothing races an exit.
 */
const DONE = "[hm-replay-done]";

/** Runs `repeats` copies of `file` through a task-primary pty; resolves the elapsed ms and the characters that came out. */
function replay(
  harness: string,
  file: string,
  repeats: number,
): Promise<{ ms: number; chars: number }> {
  return new Promise((resolve, reject) => {
    // Raw, no echo, stdin drained: the status filter answers 7501 probes
    // into the pty and those replies must not come back as output.
    const script = [
      "stty raw -echo",
      "cat >/dev/null &",
      "drain=$!",
      "i=0",
      `while [ "$i" -lt ${repeats} ]; do cat '${file}'; i=$((i+1)); done`,
      'kill "$drain" 2>/dev/null',
      `printf '%s' '${DONE}'`,
      // Stay alive until the test disposes the session (see DONE).
      "sleep 600",
    ].join("\n");
    const started = performance.now();
    let id = "";
    let chars = 0;
    // The marker can straddle chunks; keep just enough to see it.
    let tail = "";
    let done = false;
    const timer = setTimeout(() => {
      if (id) disposeSession(id);
      reject(new Error(`${harness}: replay of ${repeats} copies timed out`));
    }, 120_000);
    const session = createSession(
      120,
      40,
      {
        onData: (data) => {
          chars += data.length;
          acknowledgeSessionData(id, data.length);
          if (done) return;
          const seen = tail + data;
          if (!seen.includes(DONE)) {
            tail = seen.slice(-(DONE.length - 1));
            return;
          }
          done = true;
          clearTimeout(timer);
          const ms = performance.now() - started;
          // Every earlier byte has come through by now.
          setImmediate(() => disposeSession(id));
          resolve({ ms, chars: chars - DONE.length });
        },
        onExit: (exitCode) => {
          if (done) return;
          clearTimeout(timer);
          reject(
            new Error(
              `${harness}: shell exited (${exitCode}) before the end marker; ${chars} chars came out`,
            ),
          );
        },
      },
      {
        spec: { command: "/bin/sh", args: ["-c", script], cwd: temp, env: {} },
        taskId: `replay-${harness}`,
        primary: true,
      },
    );
    id = session.id;
  });
}

describe("recorded output fixtures", () => {
  it("exist for every built-in harness, with a long-output recording", () => {
    expect(HARNESSES.length).toBeGreaterThanOrEqual(4);
    const missing = HARNESSES.filter((harness) => {
      const dir = newestFixtureDir(harness);
      return !dir || !existsSync(join(dir, "long-output.txt"));
    });
    // Record with: node scripts/record-harness-status.mjs --harness <id> --scenario long-output
    expect(missing).toEqual([]);
  });
});

describe.each(HARNESSES)("%s output through the pty pipeline", (harness) => {
  const dir = newestFixtureDir(harness);

  it("passes every recorded fixture through intact", async () => {
    if (!dir) throw new Error(`${harness}: no fixtures`);
    const bytes = Buffer.concat(
      readdirSync(dir)
        .filter((name) => name.endsWith(".txt"))
        .sort()
        .map((name) => readFileSync(join(dir, name))),
    );
    const file = join(temp, `${harness}-all.bin`);
    writeFileSync(file, bytes);
    const run = await replay(harness, file, 1);
    // 7501 reports are stripped on the way, so a little less comes out.
    expect(run.chars).toBeGreaterThan(bytes.toString().length * 0.9);
  }, 60_000);

  // `long-output` alone: a TUI's steady-state redraw stream, repeated the
  // way a long session keeps drawing. (Mixing in the other fixtures would
  // add newlines Pi's fullscreen UI never prints, and hide a cost that
  // grows with the unterminated line.)
  it("costs linear time as a long session's output grows", async () => {
    if (!dir) throw new Error(`${harness}: no fixtures`);
    const bytes = readFileSync(join(dir, "long-output.txt"));
    const file = join(temp, `${harness}-long.bin`);
    writeFileSync(file, bytes);
    const small = Math.max(1, Math.round(SMALL_BYTES / bytes.length));
    const smallRun = await replay(harness, file, small);
    const bigRun = await replay(harness, file, small * GROWTH);
    expect(bigRun.chars).toBeGreaterThan(
      bytes.toString().length * small * GROWTH * 0.9,
    );
    const ratio = bigRun.ms / smallRun.ms;
    expect(
      ratio,
      `${harness}: ${((small * bytes.length) / 1e6).toFixed(1)} MB in ${Math.round(smallRun.ms)} ms, ${GROWTH}x in ${Math.round(bigRun.ms)} ms`,
    ).toBeLessThan(MAX_RATIO);
  }, 240_000);
});
