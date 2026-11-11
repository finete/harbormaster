import { describe, expect, it } from "vitest";
import {
  parseInline,
  parseMarkdown,
} from "../src/renderer/src/lib/inbox-markdown";

describe("inbox markdown subset", () => {
  it("parses headings, lists, code fences and paragraphs", () => {
    expect(
      parseMarkdown(
        "# Title\n\nSome **bold** text\nwraps.\n- one\n- `two`\n\n```\nx = 1\n```",
      ),
    ).toEqual([
      { type: "heading", level: 1, inline: [{ type: "text", text: "Title" }] },
      {
        type: "paragraph",
        inline: [
          { type: "text", text: "Some " },
          { type: "bold", text: "bold" },
          { type: "text", text: " text wraps." },
        ],
      },
      {
        type: "list",
        items: [
          [{ type: "text", text: "one" }],
          [{ type: "code", text: "two" }],
        ],
      },
      { type: "code", text: "x = 1" },
    ]);
  });

  it("only links http(s) targets", () => {
    expect(
      parseInline("[PR](https://github.com/a/b/pull/1) [x](javascript:alert)"),
    ).toEqual([
      { type: "link", text: "PR", href: "https://github.com/a/b/pull/1" },
      { type: "text", text: " " },
      { type: "text", text: "[x](javascript:alert)" },
    ]);
  });
});
