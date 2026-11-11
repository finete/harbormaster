// A deliberately small markdown subset for rule item bodies in the inbox
// detail pane (docs/release-plan.md "Inbox": "the rule's `body`
// (markdown)"): headings, bullet lists, fenced code, paragraphs, and inline
// **bold**, `code` and [links](https://…). Produces plain data the view
// renders as React elements, so nothing is ever injected as HTML. Pure.

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type MarkdownBlock =
  | { type: "heading"; level: number; inline: InlineToken[] }
  | { type: "list"; items: InlineToken[][] }
  | { type: "code"; text: string }
  | { type: "paragraph"; inline: InlineToken[] };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > last)
      tokens.push({ type: "text", text: text.slice(last, index) });
    if (raw.startsWith("**")) {
      tokens.push({ type: "bold", text: raw.slice(2, -2) });
    } else if (raw.startsWith("`")) {
      tokens.push({ type: "code", text: raw.slice(1, -1) });
    } else {
      const link = raw.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (link?.[1] && link[2] && /^https?:\/\//.test(link[2])) {
        tokens.push({ type: "link", text: link[1], href: link[2] });
      } else {
        tokens.push({ type: "text", text: raw });
      }
    }
    last = index + raw.length;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens;
}

export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: InlineToken[][] | null = null;
  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({
        type: "paragraph",
        inline: parseInline(paragraph.join(" ")),
      });
      paragraph = [];
    }
    if (list) {
      blocks.push({ type: "list", items: list });
      list = null;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      index++;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trimStart().startsWith("```")
      ) {
        code.push(lines[index] ?? "");
        index++;
      }
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading?.[1] && heading[2] !== undefined) {
      flush();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inline: parseInline(heading[2]),
      });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet?.[1] !== undefined) {
      if (paragraph.length > 0) {
        blocks.push({
          type: "paragraph",
          inline: parseInline(paragraph.join(" ")),
        });
        paragraph = [];
      }
      list ??= [];
      list.push(parseInline(bullet[1]));
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
