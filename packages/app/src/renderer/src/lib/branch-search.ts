// Search for the new-task composer's base-branch picker. A big repository
// lists thousands of branches (local + remote); handing them all to cmdk
// mounts one item each and re-scores and re-sorts every one of them in the
// DOM on each keystroke, which froze the renderer. The picker filters here
// instead and renders only the best few.

/** How many branches the base-branch picker renders at once. */
export const BRANCH_RESULT_LIMIT = 50;

export interface BranchMatches {
  /** The best matches, at most the limit, best first. */
  shown: string[];
  /** How many more matched than `shown` holds. */
  hidden: number;
}

function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function rank(name: string, words: readonly string[]): number | undefined {
  const lower = name.toLowerCase();
  for (const word of words) if (!lower.includes(word)) return undefined;
  const [first = ""] = words;
  if (lower === first || lower.endsWith(`/${first}`)) return 0;
  if (lower.startsWith(first) || lower.includes(`/${first}`)) return 1;
  return 2;
}

/** Whether `name` matches the picker's query (every word, case-insensitive). */
export function branchMatches(name: string, query: string): boolean {
  return rank(name, terms(query)) !== undefined;
}

/**
 * The branches matching `query`, best first: every whitespace-separated word
 * must appear (case-insensitive); the name itself (or a remote's copy of
 * it) ranks first, then a name or path segment starting with the first word,
 * then any other match. Ties keep the input order, which is git's most
 * recently committed first. O(branches) per call.
 */
export function matchBranches(
  branches: readonly string[],
  query: string,
  limit = BRANCH_RESULT_LIMIT,
): BranchMatches {
  const words = terms(query);
  if (words.length === 0) {
    return {
      shown: branches.slice(0, limit),
      hidden: Math.max(0, branches.length - limit),
    };
  }
  const buckets: string[][] = [[], [], []];
  for (const name of branches) {
    const score = rank(name, words);
    if (score !== undefined) buckets[score]?.push(name);
  }
  const all = buckets.flat();
  return {
    shown: all.slice(0, limit),
    hidden: Math.max(0, all.length - limit),
  };
}
