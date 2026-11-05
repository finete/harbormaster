import { describe, expect, it } from "vitest";
import { PiHarnessAdapter } from "../src/harness/pi-adapter.js";

describe("launch spec session-id env stamp", () => {
  it("stamps HARBORMASTER_SESSION_ID so nested pi children can be told apart", () => {
    const adapter = new PiHarnessAdapter({ stateDir: "/tmp/hm-test-state" });
    const spec = adapter.buildLaunchSpec({
      taskId: "task-1",
      workspacePath: "/tmp/wt",
      stateDir: "/tmp/hm-test-state",
      session: { mode: "new", sessionId: "sess-abc" },
    });
    expect(spec.env.HARBORMASTER_SESSION_ID).toBe("sess-abc");
  });

  it("stamps the opened file too, so a recorded conversation is the pane's own whatever id core holds", () => {
    const adapter = new PiHarnessAdapter({ stateDir: "/tmp/hm-test-state" });
    const base = {
      taskId: "task-1",
      workspacePath: "/tmp/wt",
      stateDir: "/tmp/hm-test-state",
    };
    const resumed = adapter.buildLaunchSpec({
      ...base,
      session: {
        mode: "resume",
        sessionId: "sess-abc",
        sessionPath: "/s/a.jsonl",
      },
    });
    expect(resumed.env.HARBORMASTER_SESSION_ID).toBe("sess-abc");
    expect(resumed.env.HARBORMASTER_SESSION_PATH).toBe("/s/a.jsonl");

    const opened = adapter.buildLaunchSpec({
      ...base,
      session: { mode: "open", sessionPath: "/s/b.jsonl" },
    });
    expect(opened.args).toEqual(["--session", "/s/b.jsonl"]);
    expect(opened.env.HARBORMASTER_SESSION_ID).toBeUndefined();
    expect(opened.env.HARBORMASTER_SESSION_PATH).toBe("/s/b.jsonl");
  });

  it("omits the stamp when no session decision exists (legacy --continue panes)", () => {
    const adapter = new PiHarnessAdapter({ stateDir: "/tmp/hm-test-state" });
    const spec = adapter.buildLaunchSpec({
      taskId: "task-1",
      workspacePath: "/tmp/wt",
      stateDir: "/tmp/hm-test-state",
    });
    expect(spec.env.HARBORMASTER_SESSION_ID).toBeUndefined();
  });
});
