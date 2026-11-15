// Secret redaction at the main-log write boundary (app-log.ts calls
// `redactLogLine` on every line before it reaches `main.log`): a token that
// slips into a console call (an env dump, a git URL with credentials, a
// failed HTTP request's headers) never lands on disk, so neither the log
// nor an exported diagnostics bundle carries it. Pure, single pass per
// pattern, and idempotent: `[redacted:<tag>]` never matches again, and the
// diagnostics export's own `[redacted]` redaction (diagnostics.ts) still
// applies on top unchanged.

interface Rule {
  tag: string;
  pattern: RegExp;
  /** Replacement; defaults to the whole match → `[redacted:<tag>]`. */
  replace?: (match: string, ...groups: string[]) => string;
}

const mark = (tag: string): string => `[redacted:${tag}]`;

/** Token characters that must include an uppercase letter and a digit (real keys do; branch names rarely). */
const MIXED = "(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]";

/** Key names whose `KEY=value` value is a secret. */
const SECRET_KEY_NAME =
  "[A-Za-z0-9_.-]*(?:token|secret|passw|api[-_]?key|credential|cookie|private[-_]?key)[A-Za-z0-9_.-]*";

const RULES: readonly Rule[] = [
  {
    tag: "private-key",
    // A whole PEM block; an unterminated one (cut by the line) to its end.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { tag: "anthropic-key", pattern: new RegExp(`\\bsk-ant-${MIXED}{20,}`, "g") },
  {
    tag: "openai-key",
    pattern: new RegExp(`\\bsk-(?:proj-)?${MIXED}{20,}`, "g"),
  },
  { tag: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { tag: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { tag: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    tag: "aws-secret",
    pattern: /\b(aws_secret_access_key\s*[=:]\s*)(?!\[redacted)[^\s"',;&]+/gi,
    replace: (_match, key) => `${key}${mark("aws-secret")}`,
  },
  {
    tag: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { tag: "slack-token", pattern: /\bxox[abprse]-[A-Za-z0-9-]{10,}/g },
  {
    tag: "bearer",
    pattern: /\b(Bearer\s+)(?!\[redacted)(?=[\w.~+/=-]*[0-9])[\w.~+/=-]{16,}/g,
    replace: (_match, prefix) => `${prefix}${mark("bearer")}`,
  },
  {
    tag: "url-credentials",
    // `scheme://user:pass@host`: only a userinfo WITH a password (a bare
    // `https://user@github.com` remote is not a secret).
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replace: (_match, scheme) => `${scheme}${mark("url-credentials")}@`,
  },
  {
    tag: "token",
    pattern: /([?&](?:access_token|token)=)(?!\[redacted)[^&#\s"']+/gi,
    replace: (_match, key) => `${key}${mark("token")}`,
  },
  {
    tag: "secret",
    pattern: new RegExp(
      `\\b(${SECRET_KEY_NAME}=)(?!\\[redacted)[^\\s&"',;]+`,
      "gi",
    ),
    replace: (_match, key) => `${key}${mark("secret")}`,
  },
];

/** `line` with every recognized secret replaced by `[redacted:<tag>]`. */
export function redactLogLine(line: string): string {
  let out = line;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = rule.replace
      ? out.replace(rule.pattern, rule.replace as (...args: string[]) => string)
      : out.replace(rule.pattern, mark(rule.tag));
  }
  return out;
}
