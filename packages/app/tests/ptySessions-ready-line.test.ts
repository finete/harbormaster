// The Plannotator pty fallback (docs/plannotator.md "Transport"): every
// task pty reports Plannotator's ready-line URL unless the app exported the
// open-url handler into that very pty (the session reports its URL itself).
// No such record (a launch without a handler, a task shell the user ran an
// agent in by hand, a primary that fell back to a shell) -> watched. Real
// `/bin/sh` processes via node-pty.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBackgroundPrimarySession,
  createSession,
  disposeSession,
  setReadyUrlListener,
  writeToSession,
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

  describe("a pty with no record of the handler (an agent started by hand)", () => {
    const shell = process.env.SHELL;
    beforeAll(() => {
      process.env.SHELL = "/bin/sh";
    });
    afterAll(() => {
      process.env.SHELL = shell;
    });
    // Typed into an interactive shell: the echoed input must not itself
    // read as a ready line, so the prefix is assembled by the shell.
    const TYPED =
      "P='Plannotator session'; printf '%s ready: %s\\n' \"$P\" http://127.0.0.1:4998/; echo do''ne\r";

    it("opens the review tab from a task shell pane", async () => {
      let output = "";
      const { id } = createSession(
        80,
        24,
        { onData: (data) => (output += data), onExit: () => {} },
        { taskId: "task-4", primary: false },
      );
      sessionIds.push(id);
      writeToSession(id, TYPED);
      await expect.poll(() => output, { timeout: 5000 }).toContain("done");
      expect(opened).toEqual([
        { taskId: "task-4", url: "http://127.0.0.1:4998/" },
      ]);
    });

    it("opens it from a primary that fell back to a shell, handler in its spec or not", async () => {
      let output = "";
      const { id, fellBackToShell } = createSession(
        80,
        24,
        { onData: (data) => (output += data), onExit: () => {} },
        {
          spec: {
            command: "/nonexistent/harbormaster-test-agent",
            args: [],
            cwd: process.cwd(),
            env: { PLANNOTATOR_BROWSER: "/app/bin/harbormaster-open-url" },
          },
          taskId: "task-5",
          primary: true,
        },
      );
      sessionIds.push(id);
      expect(fellBackToShell).toBe(true);
      writeToSession(id, TYPED);
      await expect.poll(() => output, { timeout: 5000 }).toContain("done");
      expect(opened).toEqual([
        { taskId: "task-5", url: "http://127.0.0.1:4998/" },
      ]);
    });
  });

  it("watches a background launch too", async () => {
    const { id } = createBackgroundPrimarySession("task-3", spec({}), () => {});
    sessionIds.push(id);
    await expect
      .poll(() => opened, { timeout: 5000 })
      .toEqual([{ taskId: "task-3", url: "http://127.0.0.1:4999/" }]);
  });
});
