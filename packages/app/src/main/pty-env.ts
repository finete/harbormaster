/**
 * PTY environment hygiene (checklist item #24).
 *
 * Strips inherited terminal-emulator identity markers from the spawning
 * environment and sets Harbormaster's own identity so child programs (pi,
 * shells, git) detect the right capabilities.
 *
 * Pure function: no Node imports, injected deps → testable without spawning.
 */

/** Environment vars that reveal another emulator's identity and must be removed. */
const EMULATOR_MARKERS = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "ITERM_SESSION_ID",
  "ITERM_PROFILE",
  "KITTY_WINDOW_ID",
  "KITTY_PID",
  "KITTY_LISTEN_ON",
  "WEZTERM_PANE",
  "WEZTERM_EXECUTABLE",
  "WT_SESSION",
  "GHOSTTY_RESOURCES_DIR",
  "GHOSTTY_BIN_DIR",
  "GHOSTTY_SHELL_FEATURES",
  "WARP_SESSION_ID",
  "WARP_TERMINAL_SESSION_UUID",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "VSCODE_INJECTION",
  "VSCODE_GIT_IPC_HANDLE",
  "TERMINAL_EMULATOR",
  "ZED_TERM",
] as const;

export interface BuildPtyEnvOptions {
  appVersion: string;
  /** Whether OSC 8 hyperlinks are supported (set after chunk E). */
  hyperlinks?: boolean;
}

/**
 * Build a sanitized environment for a pty spawn.
 *
 * @param base       The process.env to sanitize (usually the main-process env).
 * @param overlay    Per-session overrides (spec.env); applied last, wins everything.
 * @param options    App metadata for identity headers.
 */
export function buildPtyEnv(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string> | undefined,
  options: BuildPtyEnvOptions,
): Record<string, string> {
  // Shallow copy so we never mutate process.env.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) env[k] = v as string;
  }

  // Strip inherited emulator markers.
  for (const key of EMULATOR_MARKERS) {
    delete env[key];
  }

  // Set Harbormaster's own identity.
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "harbormaster";
  env.TERM_PROGRAM_VERSION = options.appVersion;

  // Opt-in to pi's OSC 8 hyperlinks (item #11) once the renderer supports them.
  if (options.hyperlinks) {
    env.PI_HYPERLINKS = "1";
  }

  // Ensure a UTF-8 locale so unicode works in shells (VS Code detectLocale parity).
  if (!env.LANG?.endsWith(".UTF-8")) {
    env.LANG = "en_US.UTF-8";
  }

  // Overlay wins everything (spec.env from PtySessionOptions).
  if (overlay) {
    Object.assign(env, overlay);
  }

  return env;
}
