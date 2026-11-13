/**
 * Shell escaping utilities — pure functions with no Node or DOM dependency.
 *
 * Native macOS terminal drop escaping + VS Code
 * `terminalEnvironment.ts:335` control-char strip.
 *
 * Shared by the renderer (drop handler, context-menu paste) and the main
 * process (clipboard-paste IPC handler); both bundles import it from this
 * path.  Add `src/shared/**\/*` to both tsconfig.node.json and
 * tsconfig.web.json includes so the type-checker sees it in each context.
 */

/** Characters that must be backslash-escaped in an unquoted shell word. */
const SHELL_SPECIALS_RE = /[ \\()[\]{}<>"'`!#$&;|*?~\t]/g;

/**
 * Strip control characters (VS Code parity, terminalEnvironment.ts:335).
 * Ranges: U+0000–U+0008, U+000B–U+001F, U+007F.
 * TAB (U+0009), LF (U+000A) and CR (U+000D) are kept intentionally.
 * Implemented without a regex literal to satisfy biome's
 * noControlCharactersInRegex rule.
 */
function stripControlChars(s: string): string {
  let result = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x00 && cp <= 0x08) ||
      (cp >= 0x0b && cp <= 0x1f && cp !== 0x0d) ||
      cp === 0x7f
    ) {
      // Skip control char.
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Escape `p` for safe insertion into a shell command line.
 *
 * Rules (native-terminal parity):
 * 1. Strip control chars first.
 * 2. If the result contains a literal newline or carriage return, single-quote
 *    the whole string with embedded single-quotes escaped as `'\''`.
 * 3. Otherwise backslash-escape each shell special character.
 */
export function shellEscapePath(p: string): string {
  // 1. Strip control chars (keep \n and \r; they are handled in step 2).
  const stripped = stripControlChars(p);

  // 2. Newline/CR → single-quote with embedded single-quote escaping.
  if (/[\n\r]/.test(stripped)) {
    return `'${stripped.replace(/'/g, "'\\''")}'`;
  }

  // 3. Backslash-escape shell specials (including backslash itself).
  return stripped.replace(SHELL_SPECIALS_RE, "\\$&");
}

/**
 * Escape and join multiple paths with a single space, as native terminals do
 * for multi-file drags (no trailing space).
 */
export function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}
