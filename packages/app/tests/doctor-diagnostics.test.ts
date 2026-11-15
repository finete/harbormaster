// The app's doctor plumbing: doctor.json in the diagnostics bundle, the
// export toast's "Copy summary" text, the app-only doctor input, and the
// Setup screen's grouping of the report.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DoctorReport } from "@harbormaster/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiagnosticsZip } from "../src/main/diagnostics";
import {
  appDoctorInput,
  diagnosticsSummary,
  doctorForDiagnostics,
} from "../src/main/doctor-ipc";
import {
  doctorHeadline,
  groupDoctorChecks,
} from "../src/renderer/src/lib/doctor-view";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const report: DoctorReport = {
  checkedAt: "2026-01-01T00:00:00.000Z",
  appVersion: "0.2.4",
  platform: "darwin",
  checks: [
    {
      group: "tools",
      id: "tools.gh-auth",
      status: "fail",
      summary: "gh is not logged in",
      remediation: "Run `gh auth login` in a terminal.",
    },
    { group: "agents", id: "agents.pi", status: "ok", summary: "Pi 1.3.0" },
    {
      group: "agents",
      id: "agents.claude",
      status: "warn",
      summary: "Claude Code is not on PATH",
    },
    {
      group: "repos",
      id: "repos.remote",
      status: "fail",
      summary: "1 of 1 remote unreachable",
      detail: "https://bob:hunter2@example.com/x.git: denied",
    },
  ],
};

describe("doctor.json in the diagnostics bundle", () => {
  it("is written (string-redacted) when given, absent otherwise", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hm-doctor-zip-"));
    dirs.push(dir);
    const configFile = path.join(dir, "config.json");
    writeFileSync(configFile, "{}");
    const base = {
      logsDir: path.join(dir, "logs"),
      configFile,
      versions: { app: "0.2.4" },
    };
    const withDoctor = path.join(dir, "with.zip");
    writeFileSync(withDoctor, buildDiagnosticsZip({ ...base, doctor: report }));
    const names = execFileSync("unzip", ["-Z1", withDoctor], {
      encoding: "utf8",
    });
    expect(names.split("\n")).toContain("doctor.json");
    const text = execFileSync("unzip", ["-p", withDoctor, "doctor.json"], {
      encoding: "utf8",
    });
    expect(text).not.toContain("hunter2");
    const parsed = JSON.parse(text) as DoctorReport;
    expect(parsed.checks.map((check) => check.id)).toEqual(
      report.checks.map((check) => check.id),
    );
    expect(parsed.checks[0]?.status).toBe("fail");

    const without = path.join(dir, "without.zip");
    writeFileSync(without, buildDiagnosticsZip(base));
    expect(
      execFileSync("unzip", ["-Z1", without], { encoding: "utf8" }),
    ).not.toContain("doctor.json");
  });
});

describe("doctor-ipc", () => {
  const facts = {
    loginShellPath: () => "/opt/homebrew/bin:/usr/bin" as string | undefined,
    appPath: "/Applications/Harbormaster.app",
    appVersion: "0.2.4",
  };

  it("adds the app-only facts to the doctor input", () => {
    expect(appDoctorInput(facts)).toEqual({
      loginShellPath: "/opt/homebrew/bin:/usr/bin",
      appPath: "/Applications/Harbormaster.app",
      appVersion: "0.2.4",
    });
    expect(
      appDoctorInput({ ...facts, loginShellPath: () => undefined }),
    ).not.toHaveProperty("loginShellPath");
  });

  it("never throws for the bundle: an error or a timeout becomes { error }", async () => {
    expect(
      await doctorForDiagnostics(
        {
          doctor: async () => {
            throw new Error("boom");
          },
        },
        facts,
      ),
    ).toEqual({ error: "boom" });
    expect(
      await doctorForDiagnostics(
        { doctor: () => new Promise(() => {}) },
        facts,
        10,
      ),
    ).toEqual({ error: "doctor timed out after 10 ms" });
  });

  it("builds the Copy summary text", () => {
    expect(
      diagnosticsSummary(report, { appVersion: "0.2.4", os: "macOS 15.3" }),
    ).toBe(
      [
        "Harbormaster 0.2.4 on macOS 15.3",
        "pi: 1.3.0",
        "claude: Claude Code is not on PATH",
        "doctor:",
        "  ✗ tools.gh-auth: gh is not logged in",
        "  ! agents.claude: Claude Code is not on PATH",
        "  ✗ repos.remote: 1 of 1 remote unreachable",
      ].join("\n"),
    );
    expect(
      diagnosticsSummary(
        { error: "boom" },
        { appVersion: "0.2.4", os: "macOS 15.3" },
      ),
    ).toBe("Harbormaster 0.2.4 on macOS 15.3\ndoctor: could not run (boom)");
  });
});

describe("doctor-view", () => {
  it("folds consecutive checks into titled groups", () => {
    expect(
      groupDoctorChecks(report).map((group) => [
        group.title,
        group.checks.map((check) => check.id),
      ]),
    ).toEqual([
      ["Tools", ["tools.gh-auth"]],
      ["Agents", ["agents.pi", "agents.claude"]],
      ["Repositories", ["repos.remote"]],
    ]);
  });

  it("headlines failures and warnings", () => {
    expect(doctorHeadline(report)).toBe("2 failed, 1 warning");
    expect(doctorHeadline({ ...report, checks: [] })).toBe("All checks passed");
  });
});
