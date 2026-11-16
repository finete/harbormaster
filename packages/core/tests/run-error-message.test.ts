// utilities/run.ts: a failed child's error message names the command but
// elides over-long arguments (a whole GraphQL query, a PR body) and caps
// the total, so a refresh warning stays a readable one-liner in a toast.

import { describe, expect, it } from "vitest";
import { describeArgs, run } from "../src/utilities/run.js";

describe("run() error message", () => {
  it("keeps short arguments verbatim", () => {
    expect(describeArgs(["pr", "list", "--head", "feature/x"])).toBe(
      "pr list --head feature/x",
    );
  });

  it("elides an over-long argument to its start plus its length", () => {
    const query = `query=${"pullRequests(headRefName: $h0) { nodes { ...pr } }\n".repeat(40)}`;
    const shown = describeArgs(["api", "graphql", "-f", query]);
    expect(shown).toContain(`(${query.length} chars)`);
    expect(shown).not.toContain("\n");
    expect(shown.length).toBeLessThan(120);
  });

  it("caps the total and counts what it dropped", () => {
    const args = Array.from({ length: 40 }, (_, i) => [
      "-f",
      `h${i}=user/some-fairly-long-branch-name-${i}`,
    ]).flat();
    const shown = describeArgs(args);
    expect(shown.length).toBeLessThan(400);
    expect(shown).toMatch(/…\(\+\d+ more args\)$/);
  });

  it("a failing run() reports the elided form", async () => {
    const long = "x".repeat(5_000);
    const error = await run("sh", ["-c", "exit 3", long]).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("(5000 chars)");
    expect(error?.message.length).toBeLessThan(300);
  });
});
