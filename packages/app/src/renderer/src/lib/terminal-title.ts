/**
 * Terminal tab title rules: a pi "primary" pane is prefixed
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

/** Minimum gap between two applied live tab-title updates (see `createTitleThrottle`). */
export const TITLE_THROTTLE_MS = 250;

/**
 * Leading+trailing throttle for live OSC title updates. A streaming agent
 * can retitle its terminal many times a second (spinner/progress titles);
 * every applied title is a dockview `setTitle`, which re-renders the tab
 * *and* fires dockview's layout-change event (the workspace re-serializes
 * and re-saves its whole layout to localStorage). The first title after a
 * quiet period applies immediately; a burst collapses to at most one apply
 * per `intervalMs`, always ending on the latest title. Unchanged titles are
 * never re-applied.
 */
export function createTitleThrottle(
  apply: (title: string) => void,
  options: {
    intervalMs?: number;
    initial?: string;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): { update: (title: string) => void; dispose: () => void } {
  const intervalMs = options.intervalMs ?? TITLE_THROTTLE_MS;
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  let applied = options.initial;
  let pending: string | undefined;
  let lastAppliedAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;

  function applyNow(title: string): void {
    pending = undefined;
    if (title === applied) return;
    applied = title;
    lastAppliedAt = now();
    apply(title);
  }

  return {
    update(title: string): void {
      if (timer !== undefined) {
        pending = title;
        return;
      }
      const wait = lastAppliedAt + intervalMs - now();
      if (wait <= 0) {
        applyNow(title);
        return;
      }
      pending = title;
      timer = setTimer(() => {
        timer = undefined;
        if (pending !== undefined) applyNow(pending);
      }, wait);
    },
    dispose(): void {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
