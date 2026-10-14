import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedRevealPath } from "../src/main/reveal-path";

// Unit coverage for the `shell:revealInFolder` IPC allowlist (main/index.ts's
// registerShellIpc): only a path under one of the configured root
// directories (codeRoot, state dir) ever reaches `shell.showItemInFolder`.
describe("isAllowedRevealPath", () => {
  const codeRoot = "/Users/dev/code";
  const stateDir = "/Users/dev/.harbormaster";
  const roots = [codeRoot, stateDir];

  it("allows a path nested under an allowed root", () => {
    expect(
      isAllowedRevealPath(
        path.join(codeRoot, ".harbormaster-worktrees", "task-1"),
        roots,
      ),
    ).toBe(true);
  });

  it("allows a root directory itself", () => {
    expect(isAllowedRevealPath(codeRoot, roots)).toBe(true);
  });

  it("allows a path under the second root", () => {
    expect(isAllowedRevealPath(path.join(stateDir, "sessions"), roots)).toBe(
      true,
    );
  });

  it("rejects a path outside every root", () => {
    expect(isAllowedRevealPath("/etc/passwd", roots)).toBe(false);
  });

  it("rejects a sibling directory that merely shares a string prefix", () => {
    expect(isAllowedRevealPath("/Users/dev/code-evil/x", roots)).toBe(false);
  });

  it("rejects path traversal that escapes the root", () => {
    expect(
      isAllowedRevealPath(path.join(codeRoot, "..", "..", "etc"), roots),
    ).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(isAllowedRevealPath(undefined, roots)).toBe(false);
    expect(isAllowedRevealPath(42, roots)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isAllowedRevealPath("", roots)).toBe(false);
  });

  it("ignores blank/undefined roots instead of allowing everything", () => {
    expect(isAllowedRevealPath("/etc/passwd", [undefined, "", "   "])).toBe(
      false,
    );
  });
});
