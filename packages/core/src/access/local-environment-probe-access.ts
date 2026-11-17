// Resource Access: `harbormaster doctor`'s machine probes (contracts/
// doctor.ts). Read-only by construction: nothing here creates, migrates or
// rewrites a file, so the CLI can run the checks against a state dir while
// the app is down. Every process probe runs through the shared runner with
// a timeout and comes back as data; nothing throws. Local probes (command
// lookups, `--version`, files, the socket) get `LOCAL_PROBE_TIMEOUT_MS`;
// network probes (`gh auth status`, `git ls-remote`) get
// `NETWORK_PROBE_TIMEOUT_MS`.

import { readFile, realpath, stat, statfs } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  type EnvironmentProbeAccess,
  LOCAL_PROBE_TIMEOUT_MS,
  NETWORK_PROBE_TIMEOUT_MS,
  type PathFacts,
  type PiExtensionFacts,
  type RemoteProbe,
  type ToolSocketFacts,
} from "../contracts/doctor.js";
import type { ProbeOutcome } from "../contracts/onboarding.js";
import {
  PI_EXTENSION_FILE,
  resolvePiExtensionsDir,
} from "../utilities/pi-extension.js";
import { runOutcome } from "../utilities/run.js";
import type { StatePaths } from "../utilities/state-paths.js";
import { LocalOnboardingProbeAccess } from "./local-onboarding-probe-access.js";

export interface LocalEnvironmentProbeAccessOptions {
  paths: StatePaths;
  env?: NodeJS.ProcessEnv;
  /** Limit for local probes; default `LOCAL_PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Limit for network probes; default `NETWORK_PROBE_TIMEOUT_MS`. */
  networkTimeoutMs?: number;
  /** The Pi extension source the host bundles (the app knows it; the CLI does not). */
  piExtensionSource?: string;
}

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

export class LocalEnvironmentProbeAccess implements EnvironmentProbeAccess {
  private readonly env: NodeJS.ProcessEnv;
  private readonly paths: StatePaths;
  private readonly timeoutMs: number;
  private readonly networkTimeoutMs: number;
  private readonly piExtensionSource: string | undefined;
  /** Same PATH lookup and `--version` runs as the wizard's probes, on the local timeout. */
  private readonly cli: LocalOnboardingProbeAccess;
  /** `gh auth status` as the wizard runs it, on the network timeout (gh asks api.github.com). */
  private readonly networkCli: LocalOnboardingProbeAccess;

  constructor(options: LocalEnvironmentProbeAccessOptions) {
    this.env = options.env ?? process.env;
    this.paths = options.paths;
    this.timeoutMs = options.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS;
    this.networkTimeoutMs =
      options.networkTimeoutMs ?? NETWORK_PROBE_TIMEOUT_MS;
    this.piExtensionSource =
      options.piExtensionSource ||
      this.env.HARBORMASTER_PI_EXTENSION_SOURCE ||
      undefined;
    this.cli = new LocalOnboardingProbeAccess({
      env: this.env,
      timeoutMs: this.timeoutMs,
    });
    this.networkCli = new LocalOnboardingProbeAccess({
      env: this.env,
      timeoutMs: this.networkTimeoutMs,
    });
  }

  processPath(): string {
    return this.env.PATH ?? "";
  }

  platform(): string {
    return process.platform;
  }

  commands(): { git: string; gh: string } {
    return {
      git: "git",
      gh: this.env.HARBORMASTER_GH_COMMAND || "gh",
    };
  }

  commandOverride(envNames: readonly string[]): string | undefined {
    return this.cli.commandOverride(envNames);
  }

  async resolveCommand(command: string): Promise<string | undefined> {
    return this.cli.resolveCommand(command).catch(() => undefined);
  }

  async resolveCommandAll(command: string): Promise<string[]> {
    return this.cli.resolveCommandAll(command).catch(() => []);
  }

  commandVersion(command: string): Promise<ProbeOutcome> {
    return this.cli.runVersion(command, ["--version"]);
  }

  runVersion(command: string, args: readonly string[]): Promise<ProbeOutcome> {
    return this.cli.runVersion(command, args);
  }

  githubAuthStatus(): Promise<ProbeOutcome> {
    return this.networkCli.githubAuthStatus();
  }

  async piExtension(): Promise<PiExtensionFacts> {
    const dir = resolvePiExtensionsDir(this.env, homedir());
    const installedPath = resolve(dir, PI_EXTENSION_FILE);
    const [installedText, bundledText] = await Promise.all([
      readOptional(installedPath),
      this.piExtensionSource
        ? readOptional(this.piExtensionSource)
        : Promise.resolve(undefined),
    ]);
    return {
      dir,
      installedPath,
      ...(installedText !== undefined ? { installedText } : {}),
      ...(this.piExtensionSource && bundledText !== undefined
        ? { bundledPath: this.piExtensionSource, bundledText }
        : {}),
    };
  }

  async pathFacts(path: string): Promise<PathFacts> {
    const info = await stat(path).catch(() => undefined);
    if (!info) return { exists: false, isDirectory: false };
    const real = await realpath(path).catch(() => undefined);
    return {
      exists: true,
      isDirectory: info.isDirectory(),
      ...(real ? { realPath: real } : {}),
    };
  }

  async configFile(): Promise<{ path: string; exists: boolean }> {
    const path = this.paths.configFile;
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    return { path, exists };
  }

  async stateDirFreeBytes(): Promise<{ path: string; freeBytes: number }> {
    // The state dir may not exist yet: measure its nearest existing parent
    // (same volume in every normal setup).
    let path = resolve(this.paths.root);
    for (;;) {
      const exists = await stat(path).then(
        () => true,
        () => false,
      );
      if (exists || dirname(path) === path) break;
      path = dirname(path);
    }
    const info = await statfs(path);
    return { path, freeBytes: Number(info.bavail) * Number(info.bsize) };
  }

  async remoteReachable(checkout: string): Promise<RemoteProbe> {
    // Through `env` so git never stops to ask for credentials on a
    // terminal (a credential helper still answers as usual).
    const started = Date.now();
    const outcome = await runOutcome(
      "env",
      [
        "GIT_TERMINAL_PROMPT=0",
        "GCM_INTERACTIVE=never",
        "git",
        "-C",
        checkout,
        "ls-remote",
        "--exit-code",
        "origin",
        "HEAD",
      ],
      { timeoutMs: this.networkTimeoutMs },
    );
    const ms = Date.now() - started;
    if (outcome.ok) return { ok: true, timedOut: false, ms };
    const lines = [outcome.stderr, outcome.stdout]
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    // The `fatal:` / `ERROR:` / `remote:` / `ssh:` lines name the cause
    // (`remote: Repository not found.` then `fatal: repository … not found`).
    const keyLines = lines.filter((line) =>
      /^(fatal|error|remote|ssh):/i.test(line),
    );
    const error =
      keyLines.length > 0 ? keyLines.slice(0, 3).join(" — ") : lines[0];
    return {
      ok: false,
      timedOut: outcome.timedOut,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(error ? { error } : {}),
      ms,
    };
  }

  async toolSocket(): Promise<ToolSocketFacts> {
    const path = this.paths.socketFile;
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) return { path, exists, responds: false };
    const answer = await this.ping(path);
    return {
      path,
      exists,
      responds: answer.ok,
      ...(answer.error ? { error: answer.error } : {}),
    };
  }

  /** One `ping` request on the tool socket's line protocol. */
  private ping(path: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolvePing) => {
      const socket = connect(path);
      socket.setEncoding("utf8");
      let buffer = "";
      const finish = (result: { ok: boolean; error?: string }): void => {
        clearTimeout(timer);
        socket.destroy();
        resolvePing(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, error: "no answer to ping" }),
        this.timeoutMs,
      );
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id: 1, method: "ping" })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          finish(
            buffer.includes('"ok":true')
              ? { ok: true }
              : { ok: false, error: "unexpected answer" },
          );
        }
      });
      socket.once("error", (error: Error) =>
        finish({ ok: false, error: error.message }),
      );
    });
  }
}
