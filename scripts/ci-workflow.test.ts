// The CI workflow parses, its real-CLI cache follows the test's pins, and
// the Electron e2e suite runs in its own macOS job (docs/harness-additions.md
// P3).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

const workflow = parse(
  readFileSync(join(__dirname, "..", ".github/workflows/ci.yml"), "utf8"),
  { uniqueKeys: true },
) as {
  on: Record<string, unknown>;
  jobs: Record<string, { "runs-on": string; steps: Step[] }>;
};

describe(".github/workflows/ci.yml", () => {
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const runs = steps.map((step) => step.run ?? "").join("\n");
  const runsOf = (job: string) =>
    (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? "").join("\n");

  it("runs on push and pull_request, checks on ubuntu-latest and e2e on macos-latest, with every step runnable", () => {
    expect(Object.keys(workflow.on)).toEqual(
      expect.arrayContaining(["push", "pull_request"]),
    );
    expect(Object.keys(workflow.jobs).sort()).toEqual(["check", "e2e"]);
    expect(workflow.jobs.check?.["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs.e2e?.["runs-on"]).toBe("macos-latest");
    for (const step of steps) expect(step.uses ?? step.run).toBeTruthy();
  });

  it("checks lint, typecheck and unit tests in `check`, without the Electron e2e", () => {
    const check = runsOf("check");
    expect(check).toMatch(/npm ci/);
    expect(check).toMatch(/npm run lint/);
    expect(check).toMatch(/npm run typecheck/);
    expect(check).toMatch(/^npm test$/m);
    expect(check).not.toMatch(/playwright|-w @harbormaster\/app|only=e2e/);
  });

  it("runs the gate's e2e step in `e2e` (build, Playwright, no uncaughtException)", () => {
    const e2e = runsOf("e2e");
    expect(e2e).toMatch(/npm ci/);
    expect(e2e).toMatch(/^npm run gate -- --only=e2e$/m);
  });

  it("keys the real-CLI cache on the pinned versions and uses it as the prefix", () => {
    expect(runs).toMatch(/node scripts\/pinned-clis\.mjs/);
    const cache = steps.find((step) =>
      String(step.with?.path).includes("real-cli"),
    );
    expect(String(cache?.with?.key)).toMatch(/steps\.pins\.outputs\.key/);
    expect(runs).toContain(
      `HARBORMASTER_REAL_CLI_PREFIX=$HOME/${String(cache?.with?.path).replace(/^~\//, "")}`,
    );
    const tier = steps.find((step) =>
      step.run?.includes("real-cli-smoke.test.ts"),
    );
    expect(tier?.env?.HARBORMASTER_REAL_CLI).toBe("1");
  });
});
