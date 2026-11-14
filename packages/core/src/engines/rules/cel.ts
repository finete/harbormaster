// Engine: CEL evaluation for rule conditions and `with` templates, via
// @marcbachmann/cel-js (zero dependencies). Pure: no I/O. Variables are
// `event`, `task`, `facts`, `repo` (see contracts/rules.ts RuleVariables).
// Optional chaining (`a.?b.orValue(x)`) is enabled.

import { type ASTNode, Environment } from "@marcbachmann/cel-js";
import type { RuleVariables } from "../../contracts/rules.js";

const environment = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
  homogeneousAggregateLiterals: false,
});

type Compiled = ((context: Record<string, unknown>) => unknown) & {
  ast: ASTNode;
};

/** Parsed expressions by source text (rules are re-read every tick). */
const compiled = new Map<string, Compiled>();
const COMPILED_CAPACITY = 500;

function compile(expression: string): Compiled {
  const hit = compiled.get(expression);
  if (hit) return hit;
  const parsed = environment.parse(expression) as unknown as Compiled;
  if (compiled.size >= COMPILED_CAPACITY) compiled.clear();
  compiled.set(expression, parsed);
  return parsed;
}

/** Throws a parse error message when `expression` is not valid CEL. */
export function assertValidCel(expression: string): void {
  compile(expression);
}

/** The parser's AST for `expression` (throws the parse error when invalid). */
export function parseCelAst(expression: string): ASTNode {
  return compile(expression).ast;
}

/** Evaluate a CEL expression; CEL ints come back as JS numbers. */
export function evaluateCel(
  expression: string,
  variables: RuleVariables | Record<string, unknown>,
): unknown {
  const run = compile(expression);
  return fromCel(run(variables as unknown as Record<string, unknown>));
}

/** A condition: must evaluate to a boolean (anything else throws). */
export function evaluateCondition(
  expression: string,
  variables: RuleVariables,
): boolean {
  const value = evaluateCel(expression, variables);
  if (typeof value !== "boolean") {
    throw new Error(
      `condition must be a boolean, got ${value === null ? "null" : typeof value}`,
    );
  }
  return value;
}

const WHOLE_TEMPLATE = /^\$\{([\s\S]+)\}$/;
const EMBEDDED_TEMPLATE = /\$\{([^}]+)\}/g;

/**
 * Render `with` values: a string that is exactly `${expr}` becomes the
 * expression's typed value; `${expr}` inside a longer string is
 * interpolated as text. Objects and arrays render recursively.
 */
export function renderTemplate(
  value: unknown,
  variables: RuleVariables,
): unknown {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_TEMPLATE);
    if (whole?.[1] && !whole[1].includes("${")) {
      return evaluateCel(whole[1].trim(), variables);
    }
    if (!value.includes("${")) return value;
    return value.replace(EMBEDDED_TEMPLATE, (_match, expression: string) =>
      stringify(evaluateCel(expression.trim(), variables)),
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplate(entry, variables));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        renderTemplate(entry, variables),
      ]),
    );
  }
  return value;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** CEL ints are BigInts and maps may be Map instances: back to plain JSON values. */
function fromCel(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value].map(([key, entry]) => [String(key), fromCel(entry)]),
    );
  }
  if (Array.isArray(value)) return value.map(fromCel);
  return value;
}
