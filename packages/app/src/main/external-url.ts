// Allowlist for the renderer's `shell:openExternal` IPC (see index.ts). The
// renderer is sandboxed with no Node access, so opening a link in the user's
// default browser has to round-trip through main — and main must never hand
// an arbitrary renderer-supplied string to `shell.openExternal` (file://,
// custom protocol handlers, javascript:, ... are all launch vectors). Only
// plain https links on github.com (PR pages today) are allowed.

const ALLOWED_HOST = "github.com";

/** Whether `value` is an https://github.com/... URL that is safe to hand to `shell.openExternal`. */
export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === ALLOWED_HOST &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    // Reject anything URL normalization had to rewrite (stray whitespace,
    // backslashes, ...): the string we open must be the string we checked.
    value.startsWith(`https://${ALLOWED_HOST}/`)
  );
}
