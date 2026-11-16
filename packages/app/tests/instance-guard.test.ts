// Single-instance guard decisions (main/instance-guard.ts): never start
// beside another host on the same state dir; a duplicate of this app quits
// quietly, a different build blocks with "already running".
import { describe, expect, it } from "vitest";
import {
  alreadyRunningMessage,
  decideStartup,
  describeStartupDecision,
} from "../src/main/instance-guard";

const own = "0.2.4";

describe("decideStartup", () => {
  it("starts when it holds the lock and nobody serves the socket", () => {
    expect(
      decideStartup({
        gotLock: true,
        owner: { state: "none" },
        ownVersion: own,
      }),
    ).toEqual({ action: "start" });
  });

  it("blocks when another build owns the socket, even with the lock and the same version", () => {
    expect(
      decideStartup({
        gotLock: true,
        owner: { state: "live", version: "0.2.1", pid: 501 },
        ownVersion: own,
      }),
    ).toEqual({
      action: "block",
      message:
        "Harbormaster 0.2.1 is already running (pid 501); quit it to continue.",
    });
    // Dev and packaged builds share a version but not a userData lock.
    expect(
      decideStartup({
        gotLock: true,
        owner: { state: "live", version: own, pid: 7 },
        ownVersion: own,
      }).action,
    ).toBe("block");
    // An old host that answers ping without its version.
    expect(
      decideStartup({
        gotLock: true,
        owner: { state: "live" },
        ownVersion: own,
      }),
    ).toEqual({
      action: "block",
      message: "An older Harbormaster is already running; quit it to continue.",
    });
    // Something holds the socket but does not answer: never start beside it.
    expect(
      decideStartup({
        gotLock: true,
        owner: { state: "unresponsive" },
        ownVersion: own,
      }).action,
    ).toBe("block");
  });

  it("quits quietly as a duplicate of this app (the lock holder focuses itself)", () => {
    for (const owner of [
      { state: "none" as const },
      { state: "live" as const, version: own, pid: 9 },
      { state: "unresponsive" as const },
    ]) {
      expect(decideStartup({ gotLock: false, owner, ownVersion: own })).toEqual(
        { action: "quit-duplicate" },
      );
    }
  });

  it("without the lock, a different version on the socket still blocks", () => {
    expect(
      decideStartup({
        gotLock: false,
        owner: { state: "live", version: "0.2.1", pid: 501 },
        ownVersion: own,
      }).action,
    ).toBe("block");
  });
});

describe("messages", () => {
  it("names an unresponsive owner", () => {
    expect(alreadyRunningMessage({ state: "unresponsive" })).toMatch(
      /not responding/,
    );
  });
  it("logs one line per decision", () => {
    expect(
      describeStartupDecision(
        { action: "block", message: "x" },
        { gotLock: true, owner: { state: "live", version: "0.2.1", pid: 501 } },
      ),
    ).toBe("[instance] lock=held socket=live 0.2.1 pid 501 -> block");
  });
});
