// The pty fallback's matcher (main/plannotator-ready-line.ts): Plannotator's
// `Plannotator session ready: <url>` line, split across chunks, coloured,
// CRLF-terminated, reported once per line.
import { describe, expect, it } from "vitest";
import { createReadyLineMatcher } from "../src/main/plannotator-ready-line";

describe("createReadyLineMatcher", () => {
  it("finds the URL once its line is complete", () => {
    const match = createReadyLineMatcher();
    expect(
      match("noise\r\nPlannotator session ready: http://127.0.0.1:4"),
    ).toEqual([]);
    expect(match("321/review\r\nmore")).toEqual([
      "http://127.0.0.1:4321/review",
    ]);
    expect(match("\r\n")).toEqual([]);
  });

  it("strips colour escapes", () => {
    const match = createReadyLineMatcher();
    expect(
      match(
        "\x1b[2mPlannotator session ready: \x1b[36mhttp://localhost:9/\x1b[0m\n",
      ),
    ).toEqual(["http://localhost:9/"]);
  });

  it("ignores other lines and keeps a bounded carry", () => {
    const match = createReadyLineMatcher();
    expect(match("x".repeat(10_000))).toEqual([]);
    expect(match("\nPlannotator session ready: not-a-url\n")).toEqual([]);
  });
});
