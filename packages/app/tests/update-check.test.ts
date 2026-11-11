import { describe, expect, it, vi } from "vitest";
import {
  compareSemver,
  createUpdateChecker,
  newerVersion,
  parseReleaseVersion,
  UPGRADE_COMMAND,
} from "../src/main/update-check";

describe("compareSemver", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["v1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.0.0", "1.0.1", -1],
    ["1.10.0", "1.9.0", 1], // numeric, not lexical
    ["2.0.0", "1.99.99", 1],
    ["0.0.10", "0.0.9", 1],
    ["1.0.0-beta", "1.0.0", -1], // a prerelease sorts below its release
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], // numeric id below alphanumeric
    ["1.0.0-beta.2", "1.0.0-beta.11", -1],
    ["1.0.0-rc.1", "1.0.0-beta.11", 1],
    ["1.0.0+build.5", "1.0.0", 0], // build metadata ignored
  ])("%s vs %s = %i", (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
    expect(compareSemver(b, a)).toBe(-expected || 0);
  });

  it("throws on a non-semver value", () => {
    expect(() => compareSemver("latest", "1.0.0")).toThrow(/not a semver/);
    expect(() => compareSemver("1.0", "1.0.0")).toThrow(/not a semver/);
  });
});

describe("parseReleaseVersion", () => {
  it("reads tag_name from the GitHub latest-release JSON", () => {
    expect(
      parseReleaseVersion(
        JSON.stringify({ tag_name: "v1.4.2", name: "Harbormaster 1.4.2" }),
      ),
    ).toBe("1.4.2");
  });

  it("accepts a plain-text tag", () => {
    expect(parseReleaseVersion("v2.0.0\n")).toBe("2.0.0");
    expect(parseReleaseVersion("2.0.0")).toBe("2.0.0");
  });

  it("rejects drafts, non-semver tags and junk", () => {
    expect(
      parseReleaseVersion(JSON.stringify({ tag_name: "v9.0.0", draft: true })),
    ).toBeUndefined();
    expect(
      parseReleaseVersion(JSON.stringify({ tag_name: "nightly" })),
    ).toBeUndefined();
    expect(
      parseReleaseVersion(JSON.stringify({ message: "Not Found" })),
    ).toBeUndefined();
    expect(parseReleaseVersion("{not json")).toBeUndefined();
    expect(parseReleaseVersion("<html>")).toBeUndefined();
  });
});

describe("newerVersion", () => {
  it("offers the upgrade only when the release is newer", () => {
    expect(newerVersion("0.1.0", "v0.2.0")).toEqual({
      version: "0.2.0",
      command: UPGRADE_COMMAND,
    });
    expect(newerVersion("0.2.0", "v0.2.0")).toBeUndefined();
    expect(newerVersion("0.3.0", "v0.2.0")).toBeUndefined();
    expect(newerVersion("0.2.0-beta.1", "v0.2.0")?.version).toBe("0.2.0");
  });

  it("stays quiet when the running version is not semver", () => {
    expect(newerVersion("dev", "v1.0.0")).toBeUndefined();
  });

  it("names the Homebrew cask upgrade", () => {
    expect(UPGRADE_COMMAND).toBe("brew upgrade --cask harbormaster");
  });
});

describe("createUpdateChecker", () => {
  it("checks on start, then on every interval, and reports each newer version once", async () => {
    const bodies = ["v0.1.0", "v0.2.0", "v0.2.0", "boom", "v0.3.0"];
    const fetchText = vi.fn(async () => {
      const body = bodies.shift() ?? "";
      if (body === "boom") throw new Error("offline");
      return body;
    });
    let tick: (() => void) | undefined;
    const onUpdate = vi.fn();
    const checker = createUpdateChecker({
      currentVersion: "0.1.0",
      url: "https://example.test/latest",
      fetchText,
      onUpdate,
      intervalMs: 1234,
      setInterval: (fn, ms) => {
        expect(ms).toBe(1234);
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = undefined;
      },
    });

    checker.start();
    await vi.waitFor(() => expect(fetchText).toHaveBeenCalledTimes(1));
    expect(fetchText).toHaveBeenCalledWith("https://example.test/latest");
    expect(onUpdate).not.toHaveBeenCalled(); // same version

    tick?.();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenLastCalledWith({
      version: "0.2.0",
      command: UPGRADE_COMMAND,
    });

    await checker.check(); // v0.2.0 again: no repeat
    await checker.check(); // fetch fails: swallowed, previous update kept
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(checker.latest()?.version).toBe("0.2.0");

    await checker.check();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(checker.latest()?.version).toBe("0.3.0");

    checker.stop();
    expect(tick).toBeUndefined();
  });
});
