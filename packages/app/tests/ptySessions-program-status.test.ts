// OSC 7501 in the pty layer (decision #18): a task primary's program-status
// reports are stripped from the stream and handed to the listener with the
// pane's pid, the feature-detection probe is answered into the pty, plain
// shells are left alone, and the process going away reports the exit. Real
// `/bin/sh` processes via node-pty, no mocks.
import type { ProgramStatusReport } from "@harbormaster/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBackgroundPrimarySession,
  createSession,
  disposeSession,
  setProgramStatusListener,
} from "../src/main/ptySessions";

const openSessionIds: string[] = [];
const reports: Array<{
  taskId: string;
  pid: number;
  report: ProgramStatusReport;
}> = [];
const exits: Array<{ taskId: string; pid: number }> = [];

setProgramStatusListener({
  onReport: (taskId, pid, report) => reports.push({ taskId, pid, report }),
  onExit: (taskId, pid) => exits.push({ taskId, pid }),
});

afterEach(() => {
  while (openSessionIds.length > 0) {
    const id = openSessionIds.pop();
    if (id) disposeSession(id);
  }
  reports.length = 0;
  exits.length = 0;
});

// Raw mode so `head -c` gets the probe answer without a newline; the answer
// is echoed back as hex so the test can read it from the output.
const PROBE_SCRIPT = [
  "stty raw -echo",
  "printf 'before\\033]7501;?\\007'",
  'answer=$(head -c 9 | od -An -tx1 | tr -d " \\n")',
  'printf "GOT:%s:" "$answer"',
  // A report split across two writes, then an ST-terminated one.
  "printf '\\033]7501;sta'",
  "sleep 0.05",
  "printf 'te=working\\007mid'",
  "printf '\\033]7501;state=blocked:msg=SGk=\\033\\\\after'",
  "sleep 30",
].join("; ");

function shSpec(script: string) {
  return {
    command: "/bin/sh",
    args: ["-c", script],
    cwd: process.cwd(),
    env: {},
  };
}

describe("program status in the pty layer", () => {
  it("answers the probe, strips reports and reports them with the pane pid", async () => {
    let output = "";
    const { id, pid } = createSession(
      80,
      24,
      { onData: (data) => (output += data), onExit: () => {} },
      { spec: shSpec(PROBE_SCRIPT), taskId: "task-1", primary: true },
    );
    openSessionIds.push(id);
    await expect.poll(() => output, { timeout: 5000 }).toContain("after");
    expect(output).toContain("GOT:1b5d373530313b3f07:");
    expect(output).toContain("before");
    expect(output).toContain("mid");
    expect(output).not.toContain("7501");
    expect(reports).toEqual([
      { taskId: "task-1", pid, report: { state: "working" } },
      { taskId: "task-1", pid, report: { state: "blocked", message: "Hi" } },
    ]);

    disposeSession(id);
    openSessionIds.pop();
    expect(exits).toEqual([{ taskId: "task-1", pid }]);
  });

  it("reports a background primary's exit when its process ends on its own", async () => {
    const { pid } = createBackgroundPrimarySession(
      "task-2",
      shSpec("printf '\\033]7501;state=done\\007'; sleep 0.2"),
      () => {},
    );
    await expect
      .poll(() => exits, { timeout: 5000 })
      .toEqual([{ taskId: "task-2", pid }]);
    expect(reports).toEqual([
      { taskId: "task-2", pid, report: { state: "done" } },
    ]);
  });

  it("leaves a plain shell's output untouched and never reports for it", async () => {
    let output = "";
    const { id } = createSession(
      80,
      24,
      { onData: (data) => (output += data), onExit: () => {} },
      { spec: shSpec("printf 'x\\033]7501;state=working\\007y'; sleep 30") },
    );
    openSessionIds.push(id);
    await expect.poll(() => output, { timeout: 5000 }).toContain("y");
    expect(output).toContain("\x1b]7501;state=working\x07");
    expect(reports).toEqual([]);
    disposeSession(id);
    openSessionIds.pop();
    expect(exits).toEqual([]);
  });
});
