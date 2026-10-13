import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "../src/main/external-url";

// Unit coverage for the `shell:openExternal` IPC allowlist (main/index.ts's
// registerShellIpc): only plain https://github.com/ links ever reach
// `shell.openExternal`. The e2e lane asserts the PR chip renders; launching
// a real browser there would be flaky and side-effectful, so the security-
// relevant part is pinned here instead.
describe("isAllowedExternalUrl", () => {
  it.each([
    "https://github.com/finete/harbormaster/pull/42",
    "https://github.com/org/repo/pull/1#discussion_r1",
    "https://github.com/org/repo/pull/7?tab=files",
  ])("allows %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    ["http (not https)", "http://github.com/org/repo/pull/1"],
    ["a lookalike host", "https://github.com.evil.example/org/repo"],
    ["a subdomain", "https://gist.github.com/org/abc"],
    ["userinfo smuggling", "https://github.com@evil.example/pull/1"],
    ["credentials", "https://user:pass@github.com/org/repo"],
    ["an explicit port", "https://github.com:8443/org/repo"],
    ["file URLs", "file:///etc/passwd"],
    ["javascript URLs", "javascript:alert(1)"],
    ["custom protocols", "vscode://github.com/org/repo"],
    ["a non-URL string", "github.com/org/repo/pull/1"],
    ["leading whitespace", " https://github.com/org/repo"],
    ["backslash normalization", "https:\\\\github.com\\org"],
    ["uppercase scheme rewrite", "HTTPS://github.com/org/repo"],
    ["the empty string", ""],
    ["a fake host from e2e fixtures", "https://example.invalid/pull/42"],
  ])("rejects %s", (_label, url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["https://github.com/a/b"]])(
    "rejects non-string %j",
    (value) => {
      expect(isAllowedExternalUrl(value)).toBe(false);
    },
  );

  it("rejects absurdly long URLs", () => {
    expect(isAllowedExternalUrl(`https://github.com/${"a".repeat(3000)}`)).toBe(
      false,
    );
  });
});
