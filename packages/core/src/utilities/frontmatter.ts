// Markdown frontmatter (`---` YAML block at the top of a SKILL.md, a Claude
// command or a Pi prompt template). Pure: the caller reads the file.

import { parse } from "yaml";

export interface Frontmatter {
  /** The block's top-level keys; `{}` when there is none or it is not a YAML map. */
  data: Record<string, unknown>;
  /** Everything after the block (the whole text when there is none). */
  body: string;
}

const BLOCK = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split `text` into its frontmatter and body. Tolerant like the agents
 * that read these files: invalid YAML yields empty `data` (the body still
 * comes back without the block).
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = BLOCK.exec(text);
  if (!match) return { data: {}, body: text };
  const body = text.slice(match[0].length);
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch {
    return { data: {}, body };
  }
  return {
    data:
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
    body,
  };
}

/** A frontmatter value as a trimmed one-line string (numbers too); `undefined` when absent or empty. */
export function frontmatterString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** The body's first non-empty line, Markdown heading marks stripped: what agents show when there is no `description`. */
export function firstLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text) return text;
  }
  return undefined;
}
