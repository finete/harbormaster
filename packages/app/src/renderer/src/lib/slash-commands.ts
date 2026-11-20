// The composer's `/` menu (docs/new-task-composer.md "Slash commands"):
// when it is open, what it matches, and what picking an entry does to the
// prompt. Pure, window-free, unit-tested; NewTaskComposer owns the state.

import type { SlashCommand } from "../../../preload/api";

/** The prompt's leading `/…` token while the caret is in it: the menu is open. */
export interface SlashTrigger {
  /** What follows the `/` up to the caret (`""` right after typing `/`). */
  query: string;
  /** Where the token ends (the caret may sit inside it): a pick replaces `[0, end)`. */
  end: number;
}

/**
 * The menu opens only for a `/` at the very start of the prompt (an agent
 * runs a command only when the message starts with it), and stays open
 * while the caret is inside that first word.
 */
export function slashTrigger(text: string, caret: number): SlashTrigger | null {
  if (!text.startsWith("/")) return null;
  const end = /^\S*/.exec(text)?.[0].length ?? 0;
  if (caret < 1 || caret > end) return null;
  return { query: text.slice(1, caret), end };
}

/** An entry's name as matched and shown: its command without the trigger (`/`, `$`). */
export function slashName(command: Pick<SlashCommand, "command">): string {
  return command.command.replace(/^[/$]/, "");
}

const SOURCE_ORDER: Record<SlashCommand["source"], number> = {
  project: 0,
  user: 1,
  plugin: 2,
};

/**
 * How well `name` matches `query` (lower is better), `undefined` = no
 * match: the whole name's prefix, then a namespace segment's (`check` in
 * `@fordefi/build:check`, `pdf` in `skill:pdf`), then a word's (`review`
 * in `plannotator-review`), then anywhere in the name, then (3+
 * characters) anywhere in the description.
 */
function rank(entry: SlashCommand, query: string): number | undefined {
  const name = slashName(entry).toLowerCase();
  if (name.startsWith(query)) return 0;
  const segments = name.split(/[:/]/);
  if (segments.some((segment) => segment.startsWith(query))) return 1;
  if (name.split(/[:/_.-]/).some((word) => word.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (query.length >= 3 && entry.description?.toLowerCase().includes(query)) {
    return 4;
  }
  return undefined;
}

/**
 * The entries matching `query`, best first; ties by source (the
 * workspace's own, then the user's, then plugins'), then name. An empty
 * query lists everything in that order.
 */
export function matchSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  const ranked: { entry: SlashCommand; rank: number }[] = [];
  for (const entry of commands) {
    const score = needle ? rank(entry, needle) : 0;
    if (score !== undefined) ranked.push({ entry, rank: score });
  }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        SOURCE_ORDER[a.entry.source] - SOURCE_ORDER[b.entry.source] ||
        slashName(a.entry).localeCompare(slashName(b.entry)),
    )
    .map(({ entry }) => entry);
}

/**
 * The prompt after picking `command` for the open trigger: the leading
 * token becomes the command, followed by one space (an existing one is
 * kept), and the caret lands after that space, ready for arguments.
 */
export function applySlashCommand(
  text: string,
  trigger: SlashTrigger,
  command: Pick<SlashCommand, "command">,
): { text: string; caret: number } {
  const rest = text.slice(trigger.end);
  const next = /^\s/.test(rest)
    ? `${command.command}${rest}`
    : `${command.command} ${rest}`;
  return { text: next, caret: command.command.length + 1 };
}

/** Next highlighted row for an arrow key, wrapping at both ends. */
export function moveSlashSelection(
  index: number,
  count: number,
  delta: 1 | -1,
): number {
  if (count === 0) return 0;
  return (((index + delta) % count) + count) % count;
}
