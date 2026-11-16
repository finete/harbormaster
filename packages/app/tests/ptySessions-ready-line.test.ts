// The Plannotator pty fallback (docs/plannotator.md "Transport"): a task
// primary launched WITHOUT the open-url handler in its env reports
// Plannotator's ready-line URL; one launched with it (the session reports
// its URL itself) never does. Real `/bin/sh` processes via node-pty.
import { afterEach, describe, expect, it } from "vitest";
import {
  createBackgroundPrimarySession,
  createSession,
  disposeSession,
  setReadyUrlListener,
} from "../src/main/ptySessions";

const opened: Array<{ taskId: string; url: string }> = [];
setReadyUrlListener((taskId, url) => opened.push({ taskId, url }));
const sessionIds: string[] = [];

afterEach(() => {
  for (const id of sessionIds.splice(0)) disposeSession(id);
  opened.length = 0;
});

const READY =
  "printf 'Plannotator session ready: http://127.0.0.1:4999/\\r\\n'; echo done; sleep 30";

function spec(env: Record<string, string>) {
  return { command: "/bin/sh", args: ["-c", READY], cwd: process.cwd(), env };
}

describe("ready-line fallback", () => {
  it("opens the URL for a launch without a handler", async () => {
    let output = "";
    const { id } = createSession(
      80,
      24,
      { onData: (data) => (output += data), onExit: () => {} },
      { spec: spec({}), taskId: "task-1", primary: true },
    );
    sessionIds.push(id);
    await expect.poll(() => output, { timeout: 5000 }).toContain("done");
    expect(opened).toEqual([
      { taskId: "task-1", url: "http://127.0.0.1:4999/" },
    ]);
  });

  it("does nothing for a launch whose env carries the handler", async () => {
    let output = "";
    const { id } = createSession(
      80,
      24,
      { onData: (data) => (output += data), onExit: () => {} },
      {
        spec: spec({ PLANNOTATOR_BROWSER: "/app/bin/harbormaster-open-url" }),
        taskId: "task-2",
        primary: true,
      },
    );
    sessionIds.push(id);
    await expect.poll(() => output, { timeout: 5000 }).toContain("done");
    expect(opened).toEqual([]);
  });

  it("watches a background launch too", async () => {
    const { id } = createBackgroundPrimarySession("task-3", spec({}), () => {});
    sessionIds.push(id);
    await expect
      .poll(() => opened, { timeout: 5000 })
      .toEqual([{ taskId: "task-3", url: "http://127.0.0.1:4999/" }]);
  });
});
