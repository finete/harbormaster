// spawn-host-client: core's git/gh runs go to a utility process, survive its
// crashes without hanging, and keep run()'s error contract (killed/code/stderr).
// The host process is faked here; the request handling it would run is the
// real `handleSpawnHostRequest` over the real in-process runner.

import {
  execFileRunner,
  type ProcessRunner,
  type ProcessRunRequest,
  run,
  setProcessRunner,
} from "@harbormaster/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSpawnHostRunner,
  type SpawnHostProcess,
} from "../src/main/spawn-host-client";
import {
  handleSpawnHostRequest,
  type SpawnHostRequest,
  type SpawnHostResponse,
} from "../src/main/spawn-host-protocol";

/** An in-memory host: answers through the real request handler unless told to hang. */
class FakeHost implements SpawnHostProcess {
  received: SpawnHostRequest[] = [];
  killed = false;
  hang = false;
  private onMessage: (message: SpawnHostResponse) => void = () => {};
  private onExit: (code: number) => void = () => {};

  constructor(private readonly runner: ProcessRunner = execFileRunner) {}

  postMessage(message: SpawnHostRequest): void {
    this.received.push(message);
    if (this.hang) return;
    void handleSpawnHostRequest(this.runner, message).then((response) =>
      this.onMessage(structuredClone(response)),
    );
  }
  on(event: "message" | "exit", listener: never): void {
    if (event === "message") this.onMessage = listener;
    else this.onExit = listener;
  }
  kill(): boolean {
    this.killed = true;
    this.exit(143);
    return true;
  }
  exit(code: number): void {
    this.onExit(code);
  }
}

function request(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): ProcessRunRequest {
  return { command, args, timeoutMs, maxBuffer: 1024 * 1024 };
}

afterEach(() => setProcessRunner(undefined));

describe("createSpawnHostRunner", () => {
  it("runs through the host, and run() keeps its error description across the hop", async () => {
    const hosts: FakeHost[] = [];
    const fallbackCalls: ProcessRunRequest[] = [];
    const runner = createSpawnHostRunner({
      fork: () => {
        const host = new FakeHost();
        hosts.push(host);
        return host;
      },
      fallback: (r) => {
        fallbackCalls.push(r);
        return execFileRunner(r);
      },
      log: () => {},
    });
    setProcessRunner(runner.run);

    expect(await run("sh", ["-c", "echo hello"])).toBe("hello");
    await expect(run("sh", ["-c", "echo boom >&2; exit 3"])).rejects.toThrow(
      /sh -c .* failed: boom/,
    );
    await expect(
      run("sleep", ["5"], undefined, { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200ms/);

    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.received).toHaveLength(3);
    expect(fallbackCalls).toEqual([]);
    runner.dispose();
    expect(hosts[0]?.killed).toBe(true);
  });

  it("a host exit fails in-flight runs (no retry) and the next run re-forks", async () => {
    const hosts: FakeHost[] = [];
    const runner = createSpawnHostRunner({
      fork: () => {
        const host = new FakeHost();
        host.hang = hosts.length === 0;
        hosts.push(host);
        return host;
      },
      fallback: execFileRunner,
      log: () => {},
    });

    const inFlight = runner.run(request("git", ["push"]));
    hosts[0]?.exit(1);
    await expect(inFlight).rejects.toThrow(
      /spawn host exited \(code 1\) before git push finished/,
    );
    expect(hosts[0]?.received).toHaveLength(1);

    const next = await runner.run(request("sh", ["-c", "echo again"]));
    expect(next.stdout.trim()).toBe("again");
    expect(hosts).toHaveLength(2);
    runner.dispose();
  });

  it("falls back in-process when no host can start or it keeps crashing", async () => {
    const fallbackCalls: string[] = [];
    const fallback: ProcessRunner = (r) => {
      fallbackCalls.push(r.args.join(" "));
      return execFileRunner(r);
    };

    const notReady = createSpawnHostRunner({
      fork: () => undefined,
      fallback,
      log: () => {},
    });
    await notReady.run(request("sh", ["-c", "echo a"]));
    const throwing = createSpawnHostRunner({
      fork: () => {
        throw new Error("no utility process");
      },
      fallback,
      log: () => {},
    });
    await throwing.run(request("sh", ["-c", "echo b"]));
    expect(fallbackCalls).toEqual(["-c echo a", "-c echo b"]);

    const crashed: FakeHost[] = [];
    const crashy = createSpawnHostRunner({
      fork: () => {
        const host = new FakeHost();
        host.hang = true;
        crashed.push(host);
        return host;
      },
      fallback,
      maxCrashes: 2,
      log: () => {},
    });
    for (let i = 0; i < 2; i++) {
      const pending = crashy.run(request("true", []));
      crashed.at(-1)?.exit(9);
      await expect(pending).rejects.toThrow(/spawn host exited \(code 9\)/);
    }
    await crashy.run(request("sh", ["-c", "echo c"]));
    expect(crashed).toHaveLength(2);
    expect(fallbackCalls).toContain("-c echo c");
  });

  it("kills a host that never answers, failing the run instead of hanging", async () => {
    const host = new FakeHost();
    host.hang = true;
    const runner = createSpawnHostRunner({
      fork: () => host,
      fallback: execFileRunner,
      watchdogGraceMs: 50,
      log: () => {},
    });
    await expect(runner.run(request("gh", ["pr", "list"], 50))).rejects.toThrow(
      /spawn host exited \(code 143\) before gh pr list finished/,
    );
    expect(host.killed).toBe(true);
  });
});
