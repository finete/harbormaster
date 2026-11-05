import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

const PID_FILE = ".fake-pi.pid";

/**
 * A stand-in `pi` (for `HARBORMASTER_PI_COMMAND`) that ignores its
 * arguments and runs a plain shell. A started chat (repository-less task)
 * gets a scratch workspace and so launches the harness in its primary pane;
 * specs that only need *a* live pane use this so the real `pi` never runs.
 *
 * It records its pid in its cwd (`exec` keeps the pid, so it is the pane's
 * pid), which {@link fakePiPid} reads back: a presence record a spec writes
 * on pi's behalf must carry the pane's pid, exactly like the real
 * presence-reporting extension, or the app distrusts it.
 */
export function writeShellPi(dir: string): string {
  const fakePi = path.join(dir, "fake-pi-shell");
  writeFileSync(
    fakePi,
    ["#!/bin/sh", `echo $$ > "$PWD/${PID_FILE}"`, "exec /bin/sh", ""].join(
      "\n",
    ),
  );
  chmodSync(fakePi, 0o755);
  return fakePi;
}

/** The pid of the {@link writeShellPi} pane running in a started chat's scratch directory. */
export async function fakePiPid(
  stateDir: string,
  taskId: string,
): Promise<number> {
  const file = path.join(stateDir, "scratch", taskId, PID_FILE);
  let pid = 0;
  await expect
    .poll(
      () => {
        try {
          pid = Number(readFileSync(file, "utf8").trim());
        } catch {
          pid = 0;
        }
        return pid;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  return pid;
}
