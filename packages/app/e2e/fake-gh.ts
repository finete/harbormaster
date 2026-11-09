// Shared piece of every e2e fake `gh`: the refresh tick looks PRs up with
// one batched `gh api graphql` call per repository (GithubPrAccess
// `statusMany`), while each spec's fake only knows `gh pr list`. This shim
// answers a graphql call by re-invoking the fake itself once per branch
// variable (`pr list --head <branch> ...`) and wrapping the answers in the
// GraphQL shape, so a spec keeps describing its PRs in `gh pr list` terms.

import { writeFileSync } from "node:fs";
import path from "node:path";

const SHIM_SOURCE = `
const { spawnSync } = require("node:child_process");
const [self, ...args] = process.argv.slice(2);
const fields = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-f" || args[i] === "-F") {
    const [key, ...rest] = args[++i].split("=");
    fields[key] = rest.join("=");
  }
}
const repository = {};
for (const key of Object.keys(fields).filter((k) => /^h\\d+$/.test(k))) {
  const child = spawnSync(self, ["pr", "list", "--head", fields[key], "--state", "all", "--limit", "1",
    "--repo", fields.owner + "/" + fields.name, "--json", "number,url,state"], { encoding: "utf8" });
  if (child.status !== 0) {
    process.stderr.write(child.stderr || "fake gh failed");
    process.exit(child.status || 1);
  }
  const nodes = JSON.parse(child.stdout || "[]").map((pr) => ({
    ...pr,
    reviewRequests: { totalCount: (pr.reviewRequests || []).length },
    reviews: { nodes: pr.reviews || [] },
  }));
  repository["b" + key.slice(1)] = { nodes };
}
process.stdout.write(JSON.stringify({ data: { repository } }));
`;

/**
 * Writes the graphql shim into `dir` and returns the `sh` line a fake gh
 * script puts right after its shebang to route `gh api graphql` through it.
 */
export function ghGraphqlShimLine(dir: string): string {
  const shim = path.join(dir, "fake-gh-graphql.cjs");
  writeFileSync(shim, SHIM_SOURCE);
  return `if [ "$1 $2" = "api graphql" ]; then exec "${process.execPath}" "${shim}" "$0" "$@"; fi`;
}
