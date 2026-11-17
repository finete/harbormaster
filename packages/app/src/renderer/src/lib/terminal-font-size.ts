// The `terminal.fontSize` setting (docs/settings.md S11) for every terminal
// pane in this window: read once through core's `getSettings`, re-read on
// a `config-changed` that touches `terminal.*` (a Settings write or a hand
// edit of config.json), and pushed to subscribed panes, which apply it live
// and refit. The renderer never reads config.json itself.

/** Mirrors core's `DEFAULT_TERMINAL_FONT_SIZE` (used until settings load). */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

/** Whether a `config-changed` payload's keys may change the terminal font size. */
export function affectsTerminalFontSize(
  changedKeys: readonly string[],
): boolean {
  return changedKeys.some(
    (key) => key === "terminal" || key.startsWith("terminal."),
  );
}

/** A usable font size from a settings value, else `undefined`. */
export function toTerminalFontSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

let current = DEFAULT_TERMINAL_FONT_SIZE;
let started = false;
const listeners = new Set<(size: number) => void>();

function apply(value: unknown): void {
  const size = toTerminalFontSize(value);
  if (size === undefined || size === current) return;
  current = size;
  for (const listener of [...listeners]) listener(size);
}

function start(): void {
  if (started) return;
  started = true;
  const core = window.harbormaster?.core;
  if (!core?.getSettings) return;
  const read = (): void => {
    core
      .getSettings()
      .then((settings) => apply(settings.values["terminal.fontSize"]))
      .catch(() => {
        // Keep the current size; the next config change re-reads.
      });
  };
  read();
  core.onConfigChanged((payload) => {
    if (affectsTerminalFontSize(payload.changedKeys)) read();
  });
}

/** The font size a new pane should open with (the last loaded setting). */
export function terminalFontSize(): number {
  start();
  return current;
}

/** Called with each new font size; returns the unsubscribe. */
export function onTerminalFontSizeChange(
  listener: (size: number) => void,
): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
