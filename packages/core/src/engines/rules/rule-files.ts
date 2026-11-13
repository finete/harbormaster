// Engine: parse and validate rules files (YAML → `Rule[]` with file and
// line numbers), and pick the active list for a repository. Pure: the
// files' text comes from RulesFileAccess.

import { Ajv, type ErrorObject } from "ajv";
import { isMap, isSeq, LineCounter, parseDocument } from "yaml";
import type {
  Rule,
  RuleActionSpec,
  RuleFile,
  RuleFileText,
} from "../../contracts/rules.js";
import { assertValidCel } from "./cel.js";
import { RULES_SCHEMA } from "./rules-schema.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validateDocument = ajv.compile(RULES_SCHEMA as object);

/** The global rules file, relative to the rules dir. */
export const GLOBAL_RULES_FILE = "rules.yaml";

/** `repos/<repository id>.yaml` for a repository id (`github.com/org/repo`). */
export function repositoryRulesFile(repositoryId: string): string {
  return `repos/${repositoryId.replace(/^\/+/, "")}.yaml`;
}

/** Parse one rules file. A file with any problem contributes no rules. */
export function parseRuleFile(source: RuleFileText): RuleFile {
  const base = {
    file: source.file,
    ...(source.repositoryId ? { repositoryId: source.repositoryId } : {}),
  };
  const lineCounter = new LineCounter();
  const document = parseDocument(source.text, {
    lineCounter,
    prettyErrors: true,
  });
  if (document.errors.length > 0) {
    return {
      ...base,
      rules: [],
      problems: document.errors.map(
        (error) => `${source.file}: ${firstLine(error.message)}`,
      ),
    };
  }
  const data: unknown = document.toJS() ?? {};
  if (!validateDocument(data)) {
    return {
      ...base,
      rules: [],
      problems: (validateDocument.errors ?? []).map(
        (error) => `${source.file}: ${describeSchemaError(error)}`,
      ),
    };
  }
  const raw = (data as { rules: RawRule[] }).rules;
  const ruleNodes = document.get("rules", true);
  const lineOf = (node: unknown): number => {
    const range = (node as { range?: [number, number, number] } | undefined)
      ?.range;
    return range ? lineCounter.linePos(range[0]).line : 0;
  };
  const problems: string[] = [];
  const seen = new Set<string>();
  const rules: Rule[] = raw.map((entry, index) => {
    const node = isSeq(ruleNodes) ? ruleNodes.items[index] : undefined;
    const doNodes = isMap(node) ? node.get("do", true) : undefined;
    const line = lineOf(node);
    if (seen.has(entry.id)) {
      problems.push(`${source.file}:${line}: duplicate rule id "${entry.id}"`);
    }
    seen.add(entry.id);
    if (entry.if !== undefined && !entry.if.startsWith("js:")) {
      try {
        assertValidCel(entry.if);
      } catch (error) {
        problems.push(
          `${source.file}:${line}: rule "${entry.id}" has an invalid condition: ${firstLine(errorMessage(error))}`,
        );
      }
    }
    const actions: RuleActionSpec[] = entry.do.map((action, actionIndex) => {
      const actionNode = isSeq(doNodes)
        ? doNodes.items[actionIndex]
        : undefined;
      const actionLine = lineOf(actionNode);
      return {
        action: action.action,
        ...(action.with ? { with: action.with } : {}),
        ...(actionLine ? { line: actionLine } : {}),
      };
    });
    return {
      id: entry.id,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      on: Array.isArray(entry.on) ? entry.on : [entry.on],
      ...(entry.if !== undefined ? { if: entry.if } : {}),
      do: actions,
      file: source.file,
      line,
    };
  });
  if (problems.length > 0) return { ...base, rules: [], problems };
  return { ...base, rules, problems: [] };
}

interface RawRule {
  id: string;
  label?: string;
  on: string | string[];
  if?: string;
  do: Array<{ action: string; with?: Record<string, unknown> }>;
}

/**
 * The ordered rule list for a task: its repository's own file when one
 * exists (it replaces the global list, even when empty), else the global
 * file's rules.
 */
export function activeRules(
  files: readonly RuleFile[],
  repositoryId: string | null | undefined,
): readonly Rule[] {
  if (repositoryId) {
    // Local-path repository ids start with "/" (fixtures); their files
    // live at repos/<id without the leading slash>.yaml.
    const wanted = repositoryId.replace(/^\/+/, "");
    const own = files.find((file) => file.repositoryId === wanted);
    if (own) return own.rules;
  }
  return files.find((file) => file.file === GLOBAL_RULES_FILE)?.rules ?? [];
}

/**
 * Whether an event type matches an `on` pattern: exact, or a glob where
 * `*` matches one dot-separated segment (or the rest of one) and `**`
 * matches anything.
 */
export function matchesEventType(pattern: string, type: string): boolean {
  if (pattern === type) return true;
  if (!pattern.includes("*")) return false;
  const regex = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^.]*"),
    )
    .join(".*");
  return new RegExp(`^${regex}$`).test(type);
}

function describeSchemaError(error: ErrorObject): string {
  const at = error.instancePath || "(root)";
  if (error.keyword === "additionalProperties") {
    return `${at}: unknown property "${String(
      (error.params as { additionalProperty?: string }).additionalProperty,
    )}"`;
  }
  if (error.keyword === "enum") {
    return `${at} ${error.message ?? "is invalid"}: ${JSON.stringify(
      (error.params as { allowedValues?: unknown }).allowedValues,
    )}`;
  }
  return `${at} ${error.message ?? "is invalid"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
