import { readFileSync } from "node:fs";

/**
 * The full initial prompt a fake agent was launched with. A long prompt
 * (every launched child's: the launch contract is appended) travels as a
 * file the argument only references (`@<path> …` for Pi/Claude, "Read the
 * file <path> …" otherwise; see core's `deliverInitialPrompt`); a short one
 * is the argument itself.
 */
export function launchedBrief(promptArg: string | null | undefined): string {
  const arg = promptArg ?? "";
  const path =
    arg.match(/^@(\S+)/)?.[1] ??
    arg.match(/^Read the file (\S+) and follow/)?.[1];
  return path ? readFileSync(path, "utf8") : arg;
}
