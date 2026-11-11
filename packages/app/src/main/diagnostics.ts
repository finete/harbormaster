// "Export diagnostics" (release plan R17: no telemetry, a user-initiated zip
// instead). Collects `<userData>/logs`, a redacted copy of the state dir's
// config.json, the app / Electron / Node versions and (best effort) the
// `harbormaster rules list` output into one archive the user can attach to
// a bug report. Everything here is a read-only copy; nothing is uploaded.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createZip, type ZipEntry } from "./zip-writer";

export const REDACTED = "[redacted]";

/** Keys whose value is a secret whatever it looks like. */
const SECRET_KEY =
  /(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|auth|credential|cookie|private[-_]?key|session[-_]?key|bearer)/i;

/** Known token shapes (GitHub, OpenAI/Anthropic-style keys, Slack, JWT). */
const SECRET_VALUE =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

/** Query parameters that commonly carry credentials. */
const SECRET_QUERY =
  /([?&](?:access_token|token|key|api_key|apikey|auth|sig|signature|password|secret|code)=)[^&#\s]*/gi;

/**
 * Redacts one string: credentials embedded in URLs (`https://user:pass@`,
 * `?token=…`) and anything shaped like a known token.
 */
export function redactString(value: string): string {
  return value
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
      `$1${REDACTED}@`,
    )
    .replace(SECRET_QUERY, `$1${REDACTED}`)
    .replace(SECRET_VALUE, REDACTED);
}

/**
 * A deep copy of a parsed config with every secret-named key's value
 * replaced by `[redacted]` and every remaining string run through
 * `redactString`. Non-secret structure (repositories, launch settings,
 * deployment stage names) stays readable for debugging.
 */
export function redactConfig(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key) && value !== null) {
    return typeof value === "boolean" ? value : REDACTED;
  }
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = redactConfig(child, childKey);
    }
    return out;
  }
  return value;
}

/** config.json, redacted; a missing or unparsable file is described, never thrown. */
export function redactedConfigText(configFile: string): string {
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf8");
  } catch {
    return `// ${configFile} does not exist\n`;
  }
  try {
    return `${JSON.stringify(redactConfig(JSON.parse(raw)), null, 2)}\n`;
  } catch {
    // Not JSON: still ship it, string-redacted, since a broken config is
    // exactly the kind of thing a diagnostics bundle should show.
    return redactString(raw);
  }
}

/** Per-file cap: a runaway log keeps only its newest bytes. */
export const MAX_LOG_FILE_BYTES = 20 * 1024 * 1024;

/** Every regular file under `logsDir` as `logs/<relative path>` entries. */
export function collectLogEntries(
  logsDir: string,
  maxBytes = MAX_LOG_FILE_BYTES,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stats.isFile()) continue;
      try {
        let data = readFileSync(path);
        if (data.length > maxBytes) data = data.subarray(-maxBytes);
        entries.push({
          name: `logs/${relative(logsDir, path).split(sep).join("/")}`,
          data,
          mtime: stats.mtime,
        });
      } catch {
        // Unreadable file: skip it rather than fail the whole export.
      }
    }
  };
  walk(logsDir);
  return entries;
}

export interface DiagnosticsInput {
  logsDir: string;
  configFile: string;
  /** Free-form environment facts (app / electron / node versions, ...). */
  versions: Record<string, string | boolean | undefined>;
  /** `harbormaster rules list` output, or why it is missing. */
  rulesList?: string;
  now?: Date;
}

/** The diagnostics archive as a ZIP buffer. */
export function buildDiagnosticsZip(input: DiagnosticsInput): Buffer {
  const now = input.now ?? new Date();
  const entries: ZipEntry[] = [
    {
      name: "versions.json",
      data: `${JSON.stringify({ exportedAt: now.toISOString(), ...input.versions }, null, 2)}\n`,
      mtime: now,
    },
    {
      name: "config.redacted.json",
      data: redactedConfigText(input.configFile),
      mtime: now,
    },
    ...collectLogEntries(input.logsDir),
  ];
  if (input.rulesList !== undefined) {
    entries.push({
      name: "rules-list.txt",
      data: redactString(input.rulesList),
      mtime: now,
    });
  }
  return createZip(entries);
}

/** Default file name offered in the save dialog. */
export function diagnosticsFileName(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[:T]/g, "-");
  return `harbormaster-diagnostics-${stamp}.zip`;
}
