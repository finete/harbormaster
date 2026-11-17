// TOML values for `codex -c key=value` overrides (docs/harness-additions.md
// X1/X6): Codex parses the value part as TOML ("if it fails to parse as
// TOML, the raw string is used as a literal", `codex --help`), so every
// value we pass must be valid TOML or it silently becomes a string.
// Pure; no I/O.

/** A string written as a TOML multi-line literal (`'''…'''`): no escapes inside, quotes and backslashes kept verbatim. */
export interface TomlLiteral {
  readonly tomlLiteral: string;
}

/** Marks `text` for the `'''…'''` literal form (falls back to a basic string when it cannot be one). */
export function tomlLiteral(text: string): TomlLiteral {
  return { tomlLiteral: text };
}

function isLiteral(value: unknown): value is TomlLiteral {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as TomlLiteral).tomlLiteral === "string"
  );
}

/** A TOML basic string (`"…"`) with every character TOML requires escaped. */
export function tomlString(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

/** A bare key when TOML allows one, else a quoted key. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/**
 * Whether `text` can be a multi-line literal: no `'''` inside (it would end
 * the string), no control characters (a literal cannot escape them), no
 * leading newline (TOML trims it). One or two quotes right before the
 * closing `'''` are valid TOML.
 */
function literalSafe(text: string): boolean {
  if (text.includes("'''")) return false;
  if (/^\r?\n/.test(text)) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: TOML forbids control characters in literals
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return false;
  return true;
}

/**
 * One TOML value: strings (basic), numbers, booleans, arrays, plain objects
 * (inline tables, keys in insertion order), and {@link tomlLiteral}
 * strings (`'''…'''` when possible). `undefined` entries of an object are
 * left out; anything else unrepresentable throws.
 */
export function tomlValue(value: unknown): string {
  if (isLiteral(value)) {
    return literalSafe(value.tomlLiteral)
      ? `'''${value.tomlLiteral}'''`
      : tomlString(value.tomlLiteral);
  }
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`not a TOML number: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${tomlKey(key)}=${tomlValue(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`not representable in TOML: ${String(value)}`);
}

/** One `-c` override argument: `<dotted key>=<TOML value>`. */
export function tomlOverride(key: string, value: unknown): string {
  return `${key}=${tomlValue(value)}`;
}
