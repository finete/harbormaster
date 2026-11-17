#!/usr/bin/env node
// The completion gate (AGENTS.md "Testing workflow", docs/harness-additions.md P3).
//
//   npm run gate           biome (lint) → typecheck → unit → app e2e,
//                          failing on any "uncaughtException" line in the
//                          app e2e output
//   npm run gate:harness   gate + real-smoke marker freshness + keyless
//                          real-CLI tier (HARBORMASTER_REAL_CLI=1; downloads
//                          the pinned CLIs unless HARBORMASTER_REAL_CLI_PREFIX
//                          names an existing install)
//
// Options: --harness (the gate:harness steps), --only=<id,id> (run a subset,
// e.g. --only=marker,real-cli). Stops at the first failing step and prints
// a one-screen summary with each step's result and duration.
//
// `npm run lint` is `biome check .` here, so "biome" and "lint" are one step.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const harness = args.includes("--harness");
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",")
  .filter(Boolean);

/** @type {{ id: string, label: string, cmd: string[], env?: Record<string,string>, forbid?: RegExp }[]} */
const STEPS = [
  { id: "lint", label: "biome check (lint)", cmd: ["npm", "run", "lint"] },
  { id: "typecheck", label: "typecheck", cmd: ["npm", "run", "typecheck"] },
  { id: "unit", label: "unit (vitest, all packages)", cmd: ["npm", "test"] },
  {
    id: "e2e",
    label: "app e2e (no uncaughtException)",
    cmd: ["npm", "test", "-w", "@harbormaster/app"],
    forbid: /uncaughtException/,
  },
];
if (harness) {
  STEPS.push(
    {
      id: "marker",
      label: "real-smoke marker fresh",
      cmd: ["node", join("scripts", "check-smoke-marker.mjs")],
    },
    {
      id: "real-cli",
      label: "keyless real-CLI tier",
      cmd: [
        "npx",
        "vitest",
        "run",
        "packages/app/tests/real-cli-smoke.test.ts",
      ],
      env: { HARBORMASTER_REAL_CLI: "1" },
    },
  );
}

if (only) {
  const unknown = only.filter((id) => !STEPS.some((step) => step.id === id));
  if (unknown.length > 0) {
    console.error(
      `gate: unknown step(s) ${unknown.join(", ")}; steps: ${STEPS.map((s) => s.id).join(", ")}`,
    );
    process.exit(2);
  }
}

/** Runs one step, teeing its output; resolves { ok, note }. */
function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd[0], step.cmd.slice(1), {
      cwd: ROOT,
      env: { ...process.env, ...step.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hits = [];
    let pending = "";
    const scan = (text) => {
      if (!step.forbid) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (step.forbid.test(line)) hits.push(line);
    };
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      scan(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      scan(chunk.toString());
    });
    child.on("error", (error) => resolve({ ok: false, note: error.message }));
    child.on("close", (code, signal) => {
      scan("\n");
      if (code !== 0) {
        resolve({
          ok: false,
          note: signal ? `signal ${signal}` : `exit ${code}`,
        });
      } else if (hits.length > 0) {
        resolve({
          ok: false,
          note: `${hits.length} line(s) match ${step.forbid}: ${hits[0].trim().slice(0, 120)}`,
        });
      } else {
        resolve({ ok: true, note: "" });
      }
    });
  });
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

const results = [];
let failed = false;
const started = Date.now();
for (const step of STEPS) {
  if (only && !only.includes(step.id)) continue;
  if (failed) {
    results.push({ step, status: "skip", ms: 0, note: "" });
    continue;
  }
  console.log(`\n=== gate: ${step.label} (${step.cmd.join(" ")})`);
  const t0 = Date.now();
  const { ok, note } = await runStep(step);
  results.push({ step, status: ok ? "ok" : "FAIL", ms: Date.now() - t0, note });
  failed ||= !ok;
}

const width = Math.max(...results.map((r) => r.step.label.length));
console.log(`\n=== gate${harness ? ":harness" : ""} summary`);
for (const r of results) {
  const time = r.status === "skip" ? "" : seconds(r.ms).padStart(8);
  console.log(
    `  ${r.status.padEnd(4)}  ${r.step.label.padEnd(width)}  ${time}${r.note ? `  ${r.note}` : ""}`,
  );
}
console.log(
  `  ${(failed ? "FAIL" : "ok").padEnd(4)}  total ${seconds(Date.now() - started)}`,
);
process.exit(failed ? 1 : 0);
