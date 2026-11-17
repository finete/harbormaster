// The CI workflow parses and its real-CLI cache follows the test's pins.
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

  it("runs on push and pull_request, on ubuntu-latest, with every step runnable", () => {
    expect(Object.keys(workflow.on)).toEqual(
      expect.arrayContaining(["push", "pull_request"]),
    );
    for (const job of Object.values(workflow.jobs)) {
      expect(job["runs-on"]).toBe("ubuntu-latest");
    }
    for (const step of steps) expect(step.uses ?? step.run).toBeTruthy();
  });

  it("checks lint, typecheck and unit tests, not the Electron e2e", () => {
    expect(runs).toMatch(/npm ci/);
    expect(runs).toMatch(/npm run lint/);
    expect(runs).toMatch(/npm run typecheck/);
    expect(runs).toMatch(/^npm test$/m);
    expect(runs).not.toMatch(/playwright|-w @harbormaster\/app/);
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
