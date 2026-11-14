// Engine: the structure-only outline of a rule's CEL condition for the
// Rules page (docs/rules-page.md decision 5). Top-level `&&` chains become
// `all`, `||` chains `any` (same-operator chains flattened, a
// parenthesised group kept as its own nested group); every other node is a
// `leaf` whose text is a verbatim slice of the source with whitespace
// collapsed. Nothing is ever re-printed or paraphrased: when the parser's
// source ranges cannot be mapped back onto balanced slices, the whole
// source is one leaf. Pure.
//
// Source slices come from the @marcbachmann/cel-js AST: every node carries
// `range: { start, end }` into the parsed input. A node's range spans its
// first to last token but omits its own wrapping parentheses (`(a + b) * c`
// starts at `a`), so each range is first widened to balanced parentheses.

import type { ASTNode } from "@marcbachmann/cel-js";
import type { CelOutline, RuleConditionView } from "../../contracts/rules.js";
import { parseCelAst } from "./cel.js";

/** The outline of a CEL expression; throws the parser's error when it does not parse. */
export function outlineCel(source: string): CelOutline {
  const ast = parseCelAst(source);
  try {
    return new Outliner(source).build(ast);
  } catch (error) {
    if (!(error instanceof UnmappableRange)) throw error;
    return {
      kind: "leaf",
      text: collapseWhitespace(source, scanSource(source)),
    };
  }
}

/** How a rule's `if` reads: absent → `always`, `js:` → the ref, else the CEL outline or its parse error. */
export function ruleConditionView(
  source: string | undefined,
): RuleConditionView {
  if (source === undefined) return { kind: "always" };
  if (source.startsWith("js:")) return { kind: "js", ref: source };
  try {
    return { kind: "cel", source, outline: outlineCel(source) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "cel-invalid",
      source,
      error: message.split("\n")[0] ?? message,
    };
  }
}

class UnmappableRange extends Error {}

/** Per character: code, inside a string literal, or inside a `//` comment. */
type CharKind = "code" | "string" | "comment";

class Outliner {
  private readonly kinds: CharKind[];

  constructor(private readonly source: string) {
    this.kinds = scanSource(source);
  }

  build(node: ASTNode): CelOutline {
    if (node.op === "&&" || node.op === "||") {
      return {
        kind: node.op === "&&" ? "all" : "any",
        items: this.chain(node, node.op),
      };
    }
    const [start, end] = this.extent(node);
    const text = collapseWhitespace(
      this.source.slice(start, end),
      this.kinds.slice(start, end),
    );
    if (!text) throw new UnmappableRange();
    return { kind: "leaf", text };
  }

  /** The operands of a same-operator chain, flattened unless parenthesised. */
  private chain(node: ASTNode, op: "&&" | "||"): CelOutline[] {
    const operands = node.args as [ASTNode, ASTNode];
    return operands.flatMap((child) =>
      child.op === op && !this.wrapped(...this.extent(child))
        ? this.chain(child, op)
        : [this.build(child)],
    );
  }

  /** The node's range widened over the parentheses it leaves unbalanced. */
  private extent(node: ASTNode): [number, number] {
    const range = node.range;
    if (
      !range ||
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end > this.source.length ||
      range.start >= range.end
    ) {
      throw new UnmappableRange();
    }
    let depth = 0;
    let lowest = 0;
    for (let index = range.start; index < range.end; index++) {
      if (this.kinds[index] !== "code") continue;
      const char = this.source[index];
      if (char === "(") depth++;
      else if (char === ")") lowest = Math.min(lowest, --depth);
    }
    let start = range.start;
    let end = range.end;
    for (let open = -lowest; open > 0; open--) {
      const at = this.previousCode(start);
      if (at < 0 || this.source[at] !== "(") throw new UnmappableRange();
      start = at;
    }
    for (let close = depth - lowest; close > 0; close--) {
      const at = this.nextCode(end);
      if (at < 0 || this.source[at] !== ")") throw new UnmappableRange();
      end = at + 1;
    }
    return [start, end];
  }

  /** Whether a balanced slice is directly wrapped in a pair of parentheses. */
  private wrapped(start: number, end: number): boolean {
    const before = this.previousCode(start);
    const after = this.nextCode(end);
    return (
      before >= 0 &&
      after >= 0 &&
      this.source[before] === "(" &&
      this.source[after] === ")"
    );
  }

  /** Index of the last code character before `index`, skipping whitespace and comments (-1 when none). */
  private previousCode(index: number): number {
    let at = index - 1;
    while (at >= 0 && this.skippable(at)) at--;
    return at >= 0 && this.kinds[at] === "code" ? at : -1;
  }

  /** Index of the first code character at or after `index`, skipping whitespace and comments (-1 when none). */
  private nextCode(index: number): number {
    let at = index;
    while (at < this.source.length && this.skippable(at)) at++;
    return at < this.source.length && this.kinds[at] === "code" ? at : -1;
  }

  private skippable(index: number): boolean {
    const kind = this.kinds[index];
    return (
      kind === "comment" ||
      (kind === "code" && /\s/.test(this.source[index] ?? ""))
    );
  }
}

/**
 * Classify every character of a CEL source as code, string literal (quotes
 * included; `'…'`, `"…"`, `'''…'''`, `"""…"""`, any prefix) or `//`
 * comment (up to, not including, the newline). A backslash always escapes
 * the next character, as the parser treats it.
 */
function scanSource(source: string): CharKind[] {
  const kinds: CharKind[] = new Array<CharKind>(source.length).fill("code");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        kinds[index++] = "comment";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const triple = source.startsWith(char.repeat(3), index);
      const quote = triple ? char.repeat(3) : char;
      const opened = index;
      index += quote.length;
      while (index < source.length && !source.startsWith(quote, index)) {
        if (!triple && source[index] === "\n") break;
        index += source[index] === "\\" ? 2 : 1;
      }
      index = Math.min(source.length, index + quote.length);
      kinds.fill("string", opened, index);
      continue;
    }
    index++;
  }
  return kinds;
}

/**
 * Runs of whitespace in code collapse to one space (trimmed at the ends);
 * string literals and comments stay verbatim, and the newline ending a
 * comment is kept so the comment cannot swallow the code after it.
 */
function collapseWhitespace(text: string, kinds: readonly CharKind[]): string {
  let out = "";
  let pending = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (kinds[index] === "code" && /\s/.test(char)) {
      if (char === "\n" && kinds[index - 1] === "comment") pending = "\n";
      else if (!pending) pending = " ";
      continue;
    }
    if (pending && out) out += pending;
    pending = "";
    out += char;
  }
  return out;
}
