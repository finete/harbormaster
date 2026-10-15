/**
 * Terminal tab title rules (cmux parity): a pi "primary" pane is prefixed
 * "π " once pi emits its own OSC title (task title), and shows bare "π"
 * before that. A plain shell defaults to its cwd's basename until the first
 * OSC title arrives from the shell itself (zsh/p10k emit `cd ~/foo && ...`
 * style titles), then tracks every subsequent change verbatim.
 */

/** Last path segment, ignoring a trailing slash; undefined for an empty/root path. */
export function basenameOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return base || undefined;
}

/** The title a terminal panel shows before its first xterm OSC title event. */
export function defaultTerminalTitle(params: {
  cwd?: string | undefined;
  primary?: boolean | undefined;
}): string {
  if (params.primary) return "π";
  return basenameOf(params.cwd) ?? "Shell";
}

/** The title a primary (pi) pane shows once pi has emitted an OSC title. */
export function piTerminalTitle(title: string): string {
  // pi's own OSC title already starts with "π - …"; don't stack prefixes.
  if (title.trimStart().startsWith("π")) return title;
  return `π ${title}`;
}

/** Truncates to `max` chars with an ellipsis; the full string is always kept elsewhere (tab `title` attribute) for the hover tooltip. */
export function truncateTitle(title: string, max = 28): string {
  if (title.length <= max) return title;
  if (max <= 1) return "…";
  return `${title.slice(0, max - 1)}…`;
}
