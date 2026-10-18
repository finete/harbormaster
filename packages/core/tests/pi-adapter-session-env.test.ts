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
