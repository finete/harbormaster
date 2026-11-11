// Real-CLI smoke (decision R15), no API key: install the pinned `claude`
// and `pi` into a throwaway npm prefix, launch each with Harbormaster's
// exact launch spec (core's adapters, real absolute `harbormaster` CLI
// path) in a real pty, and check what can be checked without a model call:
// the process starts and keeps running, the OSC 7501 probe/report path
// works (the probe is answered exactly like the app's pty layer does), and
// for Claude the per-session `--settings` / `--mcp-config` JSON is accepted
// (no usage/config error). Then the process is killed.
//
// Skipped unless HARBORMASTER_REAL_CLI=1 (it downloads ~100 MB). Optional:
// HARBORMASTER_REAL_CLI_PREFIX=<dir> reuses an install. Nothing touches the
// real ~/.claude or ~/.pi: HOME is the test sandbox (vitest.isolate-home)
// and CLAUDE_CONFIG_DIR / PI_CODING_AGENT_DIR point into the temp dir.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCodeHarnessAdapter,
  type HarnessAdapter,
  PiHarnessAdapter,
  ProgramStatusParser,
  type ProgramStatusReport,
} from "@harbormaster/core";
import * as pty from "node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Pinned versions (bump deliberately; the smoke is what proves a bump). */
export const PINNED = {
  claude: "@anthropic-ai/claude-code@2.1.322",
  pi: "@earendil-works/pi-coding-agent@1.5.2",
} as const;

const enabled = process.env.HARBORMASTER_REAL_CLI === "1";
const RUN_MS = 12_000;
const CLI = join(__dirname, "..", "..", "cli", "bin", "harbormaster.js");
/** Output that means the flags were rejected. */
const USAGE_ERROR =
  /unknown option|error: option|Invalid MCP configuration|MCP config file not found|Settings file not found|Invalid settings|too many arguments|Usage: claude/i;

interface Observation {
  output: string;
  probes: number;
  reports: ProgramStatusReport[];
  exitCode: number | null;
}

let root: string;
let prefix: string;

/** Output without CSI sequences, for the log line. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER", "SHELL"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
  env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  return env;
}

/** Runs a launch spec in a pty for `RUN_MS`, answering 7501 probes like the app does. */
function observe(
  adapter: HarnessAdapter,
  command: string,
  mapArgs: (args: string[]) => string[] = (args) => args,
): Promise<Observation> {
  const workspace = join(root, `work-${adapter.id}`);
  mkdirSync(workspace, { recursive: true });
  const spec = adapter.buildLaunchSpec({
    taskId: `smoke-${adapter.id}`,
    workspacePath: workspace,
    stateDir: join(root, "state"),
    session: {
      mode: "new",
      sessionId: "6f1f9a64-3f0e-4c38-9a38-6c5f3b1f2c01",
    },
    permissions: "bypass",
  });
  const parser = new ProgramStatusParser();
  const seen: Observation = {
    output: "",
    probes: 0,
    reports: [],
    exitCode: null,
  };
  return new Promise((resolve) => {
    const child = pty.spawn(command, mapArgs(spec.args), {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: spec.cwd,
      env: { ...sandboxEnv(), ...spec.env },
    });
    child.onData((data) => {
      const result = parser.feed(data);
      seen.output += result.output;
      seen.reports.push(...result.reports);
      for (const reply of result.replies) {
        seen.probes += 1;
        child.write(reply);
      }
    });
    const timer = setTimeout(() => {
      if (seen.exitCode === null) child.kill();
      resolve(seen);
    }, RUN_MS);
    child.onExit(({ exitCode }) => {
      seen.exitCode = exitCode;
      clearTimeout(timer);
      resolve(seen);
    });
  });
}

describe.skipIf(!enabled)("real CLI smoke (no API key)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "harbormaster-real-cli-"));
    mkdirSync(join(root, "claude-config"), { recursive: true });
    mkdirSync(join(root, "pi-agent"), { recursive: true });
    prefix = process.env.HARBORMASTER_REAL_CLI_PREFIX || join(root, "prefix");
    if (!existsSync(join(prefix, "node_modules", ".bin", "claude"))) {
      execFileSync(
        "npm",
        [
          "install",
          "--prefix",
          prefix,
          "--no-audit",
          "--no-fund",
          "--no-save",
          PINNED.claude,
          PINNED.pi,
        ],
        { stdio: "inherit", timeout: 600_000 },
      );
    }
  }, 660_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    "claude starts with our flags, accepts --settings/--mcp-config and answers to the 7501 probe",
    async () => {
      const seen = await observe(
        new ClaudeCodeHarnessAdapter({ cliPath: CLI }),
        join(prefix, "node_modules", ".bin", "claude"),
      );
      console.log(
        "[real-cli-smoke] claude",
        JSON.stringify({
          exitCode: seen.exitCode,
          probes: seen.probes,
          reports: seen.reports,
          tail: plain(seen.output).slice(-600),
        }),
      );
      expect(seen.output).not.toMatch(USAGE_ERROR);
      // Still running when we killed it (no usage error exit).
      expect(seen.exitCode).toBeNull();
      expect(seen.output.length).toBeGreaterThan(0);
      // Claude probed for OSC 7501 and got the app's answer. (Without a
      // login it sits in onboarding, so no report follows.)
      expect(seen.probes).toBeGreaterThan(0);
    },
    RUN_MS + 30_000,
  );

  it(
    "control: the same launch with a broken --mcp-config is rejected (the check above can fail)",
    async () => {
      const seen = await observe(
        new ClaudeCodeHarnessAdapter({ cliPath: CLI }),
        join(prefix, "node_modules", ".bin", "claude"),
        (args) => {
          const next = [...args];
          next[next.indexOf("--mcp-config") + 1] = "{not json";
          return next;
        },
      );
      expect(seen.output).toMatch(USAGE_ERROR);
      expect(seen.exitCode).not.toBeNull();
    },
    RUN_MS + 30_000,
  );

  it(
    "pi starts with our flags and reports OSC 7501",
    async () => {
      const seen = await observe(
        new PiHarnessAdapter({ cliPath: CLI }),
        join(prefix, "node_modules", ".bin", "pi"),
      );
      console.log(
        "[real-cli-smoke] pi",
        JSON.stringify({
          exitCode: seen.exitCode,
          probes: seen.probes,
          reports: seen.reports,
          tail: plain(seen.output).slice(-600),
        }),
      );
      expect(seen.output).not.toMatch(/unknown option|Unknown option/i);
      expect(seen.exitCode).toBeNull();
      // PI_PROGRAM_STATUS=1: reports without waiting for the probe.
      expect(seen.reports.length + seen.probes).toBeGreaterThan(0);
    },
    RUN_MS + 30_000,
  );
});
