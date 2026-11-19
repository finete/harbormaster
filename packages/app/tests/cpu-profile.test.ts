// Main-process CPU profiles (main/cpu-profile.ts): when one is due, how
// main's CPU % is measured, how many are kept, and that the in-process
// in-process profiler really samples a busy main thread.
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCpuWindow,
  createMainProfiler,
  createProfileTrigger,
  listProfiles,
  profileFileName,
  pruneProfiles,
  recordMainThreadProfile,
} from "../src/main/cpu-profile";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-profiles-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("profile trigger", () => {
  const lag = { p95Ms: 100, windowMs: 10_000 };
  const cpu = { percent: 80, windowMs: 60_000 };

  /** 100 ms lag samples from `from` to `to` (inclusive), all `ms` late. */
  function feed(
    trigger: ReturnType<typeof createProfileTrigger>,
    from: number,
    to: number,
    ms: number,
  ) {
    const due = [];
    for (let t = from; t <= to; t += 100) {
      const result = trigger.onLag(ms, t);
      if (result) due.push({ t, ...result });
    }
    return due;
  }

  it("fires on lag only once the p95 over a whole window is over the threshold", () => {
    const trigger = createProfileTrigger({ lag, cpu, cooldownMs: 600_000 });
    // Short burst: never spans the window.
    expect(feed(trigger, 0, 5_000, 300)).toEqual([]);
    // Sustained: fires once the window is (almost) covered.
    const due = feed(trigger, 5_100, 20_000, 300);
    expect(due[0]).toMatchObject({ trigger: "lag" });
    expect(due[0]?.detail).toMatch(/lag p95 300 ms over 10 s/);
  });

  it("ignores healthy lag and respects the cooldown after a profile", () => {
    const trigger = createProfileTrigger({ lag, cpu, cooldownMs: 600_000 });
    expect(feed(trigger, 0, 30_000, 20)).toEqual([]);
    trigger.profiled(30_000);
    expect(feed(trigger, 30_100, 200_000, 500)).toEqual([]);
    expect(feed(trigger, 630_100, 650_000, 500)[0]).toMatchObject({
      trigger: "lag",
    });
  });

  it("fires on CPU only when the percentage covers the full window", () => {
    const trigger = createProfileTrigger({ lag, cpu, cooldownMs: 600_000 });
    expect(trigger.onCpu(97, 30_000, 1_000)).toBeNull();
    expect(trigger.onCpu(60, 60_000, 2_000)).toBeNull();
    expect(trigger.onCpu(97, 60_000, 3_000)).toEqual({
      trigger: "cpu",
      detail: "main 97% CPU over 60 s",
    });
    trigger.profiled(3_000);
    expect(trigger.onCpu(97, 60_000, 4_000)).toBeNull();
  });
});

describe("createCpuWindow", () => {
  it("measures CPU % over the trailing window", () => {
    const window = createCpuWindow(60_000);
    expect(window.sample(0, { user: 0, system: 0 })).toEqual({
      percent: 0,
      coveredMs: 0,
    });
    // 30 s later, 15 s of CPU used: 50% over 30 s (window not covered yet).
    expect(
      window.sample(30_000, { user: 10_000_000, system: 5_000_000 }),
    ).toEqual({
      percent: 50,
      coveredMs: 30_000,
    });
    // Busy from then on: a full window ending at 95 s, from the 30 s point.
    window.sample(60_000, { user: 40_000_000, system: 5_000_000 });
    const full = window.sample(95_000, { user: 75_000_000, system: 5_000_000 });
    expect(full.coveredMs).toBeGreaterThanOrEqual(60_000);
    expect(Math.round(full.percent)).toBe(100);
  });
});

describe("profile files", () => {
  it("names a profile by time and trigger, keeps only the newest", () => {
    expect(profileFileName(new Date("2026-11-19T14:05:12.123Z"), "cpu")).toBe(
      "2026-11-19T14-05-12-123Z-cpu.cpuprofile",
    );
    const dir = tempDir();
    for (let i = 0; i < 5; i++) {
      const path = join(dir, `p${i}.cpuprofile`);
      writeFileSync(path, "{}");
      utimesSync(path, 1_000 + i, 1_000 + i);
    }
    writeFileSync(join(dir, "notes.txt"), "kept: not a profile");
    pruneProfiles(dir, 3);
    expect(listProfiles(dir).map((p) => p.name)).toEqual([
      "p4.cpuprofile",
      "p3.cpuprofile",
      "p2.cpuprofile",
    ]);
    expect(readdirSync(dir)).toContain("notes.txt");
  });

  it("saves one profile at a time and logs the outcome", async () => {
    const dir = join(tempDir(), "profiles");
    const lines: string[] = [];
    let release: (json: string) => void = () => {};
    const profiler = createMainProfiler({
      dir,
      log: (line) => lines.push(line),
      now: () => new Date("2026-11-19T14:05:12.000Z"),
      record: () => new Promise((resolve) => (release = resolve)),
    });
    const first = profiler.profile("cpu", 5_000, "main 97% CPU over 60 s");
    expect(profiler.busy()).toBe(true);
    expect(await profiler.profile("manual", 10_000)).toBeNull();
    release('{"nodes":[]}');
    const path = await first;
    expect(path).toBe(join(dir, "2026-11-19T14-05-12-000Z-cpu.cpuprofile"));
    expect(lines[0]).toMatch(
      /^\[profile\] saved 2026-11-19T14-05-12-000Z-cpu\.cpuprofile \(trigger: cpu, main 97% CPU over 60 s; 5 s, 0 KB\)$/,
    );

    const failing = createMainProfiler({
      dir,
      log: (line) => lines.push(line),
      record: () => Promise.reject(new Error("inspector unavailable")),
    });
    expect(await failing.profile("lag", 5_000)).toBeNull();
    expect(lines[1]).toBe(
      "[profile] failed (trigger: lag): inspector unavailable",
    );
  });
});

describe("recordMainThreadProfile (the real V8 profiler)", () => {
  it("samples the main thread while it is busy", async () => {
    function burnTheMainThread(until: number): number {
      let n = 0;
      while (Date.now() < until) n += Math.sqrt(n + 1);
      return n;
    }
    const recording = recordMainThreadProfile(600);
    // Keep the thread busy in a named function the profile must show.
    await new Promise((resolve) => setTimeout(resolve, 50));
    burnTheMainThread(Date.now() + 400);
    const profile = JSON.parse(await recording) as {
      nodes: Array<{ id: number; callFrame: { functionName: string } }>;
      samples: number[];
    };
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const names = new Set(
      profile.samples.map((id) => byId.get(id)?.callFrame.functionName),
    );
    expect(names.has("burnTheMainThread")).toBe(true);
  });
});
