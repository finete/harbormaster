import { describe, expect, it } from "vitest";
import {
  mergePath,
  readLoginShellPath,
  wellKnownBinDirs,
} from "../src/main/login-shell-path";

describe("mergePath", () => {
  it("puts the shell PATH first, then the current one, then well-known dirs, without duplicates or blanks", () => {
    expect(mergePath("/a:/b", "/b::/c", ["/c", "/d"]).split(":")).toEqual([
      "/a",
      "/b",
      "/c",
      "/d",
    ]);
  });

  it("falls back to the current PATH plus well-known dirs when the shell gave nothing", () => {
    expect(mergePath(undefined, "/usr/bin", ["/opt/homebrew/bin"])).toBe(
      "/usr/bin:/opt/homebrew/bin",
    );
  });
});

describe("wellKnownBinDirs", () => {
  it("includes Claude Code's ~/.local/bin and Homebrew", () => {
    const dirs = wellKnownBinDirs("/Users/x");
    expect(dirs).toContain("/Users/x/.local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
  });
});

describe("readLoginShellPath", () => {
  it("extracts the PATH between the markers, ignoring profile noise", () => {
    const run = () =>
      "Welcome!\nsome warning\n__HARBORMASTER_PATH__/x/bin:/y/bin__HARBORMASTER_PATH__\n";
    expect(readLoginShellPath("/bin/zsh", run)).toBe("/x/bin:/y/bin");
  });

  it("returns undefined when the shell fails, times out, or prints no markers", () => {
    expect(
      readLoginShellPath("/bin/zsh", () => {
        throw new Error("timeout");
      }),
    ).toBeUndefined();
    expect(readLoginShellPath("/bin/zsh", () => "garbage")).toBeUndefined();
    expect(readLoginShellPath(undefined, () => "")).toBeUndefined();
  });

  it("runs the shell as an interactive login shell", () => {
    let seen: string[] = [];
    readLoginShellPath("/bin/zsh", (_file, args) => {
      seen = args;
      return "__HARBORMASTER_PATH__/p__HARBORMASTER_PATH__";
    });
    expect(seen[0]).toBe("-ilc");
  });
});
