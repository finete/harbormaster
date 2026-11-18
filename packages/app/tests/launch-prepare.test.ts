// The launcher's side of LaunchSpec.prepare / hookStatus
// (docs/harness-additions.md C2, C9): files written before the spawn,
// never outside their directory; a hooks-reporting program that fires no
// session-start hook is ready once its pty went quiet.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHookReadyWatcher,
  launchRefusal,
  materializeLaunchFiles,
  materializeLaunchSpecFiles,
} from "../src/main/launch-prepare";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("materializeLaunchFiles", () => {
  it("writes every file with its parents, replacing stale content", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-prepare-"));
    dirs.push(root);
    const dir = join(root, "cursor-plugins", "task-1");
    materializeLaunchFiles({
      dir,
      files: {
        ".cursor-plugin/plugin.json": '{"name":"harbormaster"}\n',
        "hooks/hooks.json": '{"version":1}\n',
      },
    });
    writeFileSync(join(dir, "hooks/hooks.json"), "stale");
    materializeLaunchFiles({ dir, files: { "hooks/hooks.json": "fresh" } });
    expect(readFileSync(join(dir, ".cursor-plugin/plugin.json"), "utf8")).toBe(
      '{"name":"harbormaster"}\n',
    );
    expect(readFileSync(join(dir, "hooks/hooks.json"), "utf8")).toBe("fresh");
  });

  it("refuses a relative directory or a path escaping it", () => {
    expect(() =>
      materializeLaunchFiles({ dir: "relative", files: { a: "x" } }),
    ).toThrow(/absolute/);
    const root = mkdtempSync(join(tmpdir(), "hm-prepare-"));
    dirs.push(root);
    expect(() =>
      materializeLaunchFiles({ dir: root, files: { "../evil": "x" } }),
    ).toThrow(/escapes/);
    expect(() =>
      materializeLaunchFiles({ dir: root, files: { "/etc/evil": "x" } }),
    ).toThrow(/escapes/);
  });
});

describe("launchRefusal / materializeLaunchSpecFiles", () => {
  it("refuses an argument a managed Mac kills at exec (943+ chars), allows one under the limit", () => {
    expect(launchRefusal({ args: ["--", "x".repeat(899)] })).toBeUndefined();
    expect(launchRefusal({ args: ["--", "x".repeat(900)] })).toMatch(
      /argument 2 is 900 characters/,
    );
    expect(
      launchRefusal({
        args: Array.from({ length: 50 }, () => "x".repeat(500)),
      }),
    ).toBeUndefined();
  });

  it("writes the prompt file where the arguments point, with its parents", () => {
    const root = mkdtempSync(join(tmpdir(), "hm-prompt-"));
    dirs.push(root);
    const path = join(root, "prompts", "task-1.md");
    materializeLaunchSpecFiles({
      args: ["--", `@${path}`],
      promptFile: { path, text: "the long brief" },
    });
    expect(readFileSync(path, "utf8")).toBe("the long brief");
    expect(() =>
      materializeLaunchSpecFiles({
        args: [],
        promptFile: { path: "relative.md", text: "x" },
      }),
    ).toThrow(/absolute/);
  });
});

describe("createHookReadyWatcher", () => {
  function fakeTimers() {
    const timers = new Map<number, () => void>();
    let next = 0;
    return {
      setTimer: (fn: () => void) => {
        timers.set(++next, fn);
        return next;
      },
      clearTimer: (id: unknown) => {
        timers.delete(id as number);
      },
      fire: () => {
        for (const [id, fn] of [...timers]) {
          timers.delete(id);
          fn();
        }
      },
      pending: () => timers.size,
    };
  }

  it("fires once, only after output went quiet, never before the first output", () => {
    const timers = fakeTimers();
    let ready = 0;
    const watcher = createHookReadyWatcher({
      onReady: () => {
        ready++;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(timers.pending()).toBe(0);
    watcher.feed();
    watcher.feed(); // more output restarts the quiet period
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(ready).toBe(1);
    watcher.feed();
    timers.fire();
    expect(ready).toBe(1);
  });

  it("never fires after dispose (the program exited)", () => {
    const timers = fakeTimers();
    let ready = 0;
    const watcher = createHookReadyWatcher({
      onReady: () => {
        ready++;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    watcher.feed();
    watcher.dispose();
    timers.fire();
    expect(ready).toBe(0);
  });
});
