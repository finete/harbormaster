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
import { ruleConditionView } from "./outline.js";
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
    path: source.path,
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
  const ruleNodes = document.get("rules", true);
  const lineOf = (node: unknown): number => {
    const range = (node as { range?: [number, number, number] } | undefined)
      ?.range;
    return range ? lineCounter.linePos(range[0]).line : 0;
  };
  if (!validateDocument(data)) {
    return {
      ...base,
      rules: [],
      problems: (validateDocument.errors ?? []).map((error) => {
        const missingLabel = missingLabelRule(error);
        if (missingLabel === undefined) {
          return `${source.file}: ${describeSchemaError(error)}`;
        }
        const node = isSeq(ruleNodes)
          ? ruleNodes.items[missingLabel]
          : undefined;
        const id = (data as { rules?: Array<{ id?: unknown }> }).rules?.[
          missingLabel
        ]?.id;
        const name = typeof id === "string" ? id : `#${missingLabel + 1}`;
        return `${source.file}:${lineOf(node)}: rule "${name}": label is required`;
      }),
    };
  }
  const raw = (data as { rules: RawRule[] }).rules;
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
    const condition = ruleConditionView(entry.if);
    if (condition.kind === "cel-invalid") {
      problems.push(
        `${source.file}:${line}: rule "${entry.id}" has an invalid condition: ${condition.error}`,
      );
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
      label: entry.label,
      on: Array.isArray(entry.on) ? entry.on : [entry.on],
      ...(entry.if !== undefined ? { if: entry.if } : {}),
      do: actions,
      file: source.file,
      line,
      condition,
    };
  });
  if (problems.length > 0) return { ...base, rules: [], problems };
  return { ...base, rules, problems: [] };
}

interface RawRule {
  id: string;
  label: string;
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

/** The rule index a schema error reports a missing (or empty) `label` for. */
function missingLabelRule(error: ErrorObject): number | undefined {
  const missing =
    error.keyword === "required" &&
    (error.params as { missingProperty?: string }).missingProperty === "label"
      ? error.instancePath.match(/^\/rules\/(\d+)$/)
      : error.keyword === "minLength"
        ? error.instancePath.match(/^\/rules\/(\d+)\/label$/)
        : null;
  return missing?.[1] !== undefined ? Number(missing[1]) : undefined;
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

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
