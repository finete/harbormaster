// Allowlist for the renderer's `shell:openExternal` IPC (see index.ts). The
// renderer is sandboxed with no Node access, so opening a link in the user's
// default browser has to round-trip through main — and main must never hand
// an arbitrary renderer-supplied string to `shell.openExternal` (file://,
// custom protocol handlers, javascript:, ... are all launch vectors). Only
// plain https links on github.com — or on the GitHub (Enterprise) host of a
// repository discovered under the code root — are allowed.

const ALLOWED_HOST = "github.com";

/**
 * GitHub-ish hosts (github.com, `*github*` Enterprise Server hosts,
 * `*.ghe.com` Enterprise Cloud) of discovered repositories' normalized ids
 * (`host/owner/repo`); local-path ids and other forges never qualify.
 */
export function githubHostsFromRepositoryIds(
  repositoryIds: readonly string[],
): string[] {
  const hosts = new Set<string>();
  for (const id of repositoryIds) {
    const host = id.split("/")[0]?.toLowerCase() ?? "";
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    if (host.includes("github") || host.endsWith(".ghe.com")) hosts.add(host);
  }
  return [...hosts];
}

/** Whether `value` is an https URL on github.com (or one of `extraHosts`) that is safe to hand to `shell.openExternal`. */
export function isAllowedExternalUrl(
  value: unknown,
  extraHosts: readonly string[] = [],
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = [ALLOWED_HOST, ...extraHosts].find(
    (candidate) => candidate === parsed.hostname,
  );
  return (
    host !== undefined &&
    parsed.protocol === "https:" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    // Reject anything URL normalization had to rewrite (stray whitespace,
    // backslashes, ...): the string we open must be the string we checked.
    value.startsWith(`https://${host}/`)
  );
}
