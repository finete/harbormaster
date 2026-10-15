// Resource Access: reads task identity/state/titles out of pi-home's Beads
// database by shelling out to the same `bd` CLI pi-home's own
// `BeadsIssueAccess` (src/access/beads-issue-access.ts) uses — `bd list
// --all --json` against pi-home's beads root (`<piHomeDir>/beads`). This
// module never calls a mutating `bd` subcommand: identity/state/titles are
// read, not written, anywhere in Beads.

import { run } from "../../utilities/run.js";
import type { BeadsIssue } from "../contracts.js";

type Execute = (
  command: string,
  args: string[],
  cwd?: string,
) => Promise<string>;

export class PiHomeBeadsAccess {
  constructor(
    private readonly beadsRoot: string,
    private readonly execute: Execute = run,
  ) {}

  async listIssues(): Promise<BeadsIssue[]> {
    const raw = await this.execute(
      "bd",
      ["list", "--all", "--json"],
      this.beadsRoot,
    );
    return parseList(raw || "[]");
  }
}

function parseList(raw: string): BeadsIssue[] {
  const value = parseJson(raw);
  const list = Array.isArray(value) ? value : unwrap(value);
  if (!Array.isArray(list)) {
    throw new Error("Invalid Beads JSON: expected an issue list");
  }
  return list.map(mapIssue);
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid Beads JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function mapIssue(value: unknown): BeadsIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Beads JSON: expected an issue object");
  }
  const x = value as Record<string, unknown>;
  if (typeof x.id !== "string" || typeof x.title !== "string") {
    throw new Error("Invalid Beads JSON: issue id/title missing");
  }
  if (typeof x.status !== "string") {
    throw new Error(`Invalid Beads JSON for ${x.id}: status missing`);
  }
  const metadata =
    x.metadata && typeof x.metadata === "object" && !Array.isArray(x.metadata)
      ? (x.metadata as Record<string, unknown>)
      : {};
  return {
    id: x.id,
    title: x.title,
    description: typeof x.description === "string" ? x.description : "",
    status: x.status,
    createdAt:
      typeof x.created_at === "string"
        ? x.created_at
        : new Date(0).toISOString(),
    updatedAt:
      typeof x.updated_at === "string"
        ? x.updated_at
        : new Date(0).toISOString(),
    ...(typeof x.closed_at === "string" ? { closedAt: x.closed_at } : {}),
    ...(typeof metadata.pi_home_task_id === "string"
      ? { piHomeTaskId: metadata.pi_home_task_id }
      : {}),
  };
}
