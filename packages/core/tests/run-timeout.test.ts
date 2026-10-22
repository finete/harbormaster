// utilities/run.ts: a hung child must not hang its caller forever. run()
// rejects and tryRun() reports failure once the timeout fires, and the child
// is actually killed (SIGKILL), not merely abandoned.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, tryRun } from "../src/utilities/run.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("run() / tryRun() timeout", () => {
  it("run() kills a hung child and rejects with a timeout error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harbormaster-run-timeout-"));
    dirs.push(dir);
    const pidFile = join(dir, "pid");
    const started = Date.now();
    await expect(
      // 1.5s, not less: under parallel suite load `sh` can take hundreds of
      // ms just to start, and the pid file must exist before the kill.
      run("sh", ["-c", `echo $$ > "${pidFile}"; exec sleep 30`], undefined, {
        timeoutMs: 1_500,
      }),
    ).rejects.toThrow(/timed out after 1500ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  });

  it("tryRun() reports a timeout as failure (undefined)", async () => {
    const started = Date.now();
    expect(
      await tryRun("sleep", ["30"], undefined, { timeoutMs: 300 }),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a fast command is unaffected by the default timeout", async () => {
    expect(await run("sh", ["-c", "echo ok"])).toBe("ok");
    expect(await tryRun("sh", ["-c", "echo ok"])).toBe("ok");
  });
});
