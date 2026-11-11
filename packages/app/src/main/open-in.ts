// "Open in …" (editor / terminal / file manager) for a task's whole worktree
// folder. Mirrors Plannotator's open-in feature (catalog + availability +
// argv launcher), adapted to Harbormaster's target, which is always a
// DIRECTORY (the task's worktree / workspace folder), never a file.
//
// Safety, same as Plannotator's launcher:
//   - every launch is an argv array handed to `spawn` (never a shell string),
//   - only catalog ids launch anything; there is no fallback to the OS
//     default handler (an unknown id is refused, not "opened"),
//   - the path itself is allowlisted by the IPC handler in index.ts (the
//     same roots as `shell:revealInFolder`, see reveal-path.ts).
//
// The catalog and the argv builder are pure (unit-tested in
// tests/open-in.test.ts); `isOpenInAppAvailable` takes injected `exists` /
// `which` probes so availability is testable without touching the host.

import { spawn } from "node:child_process";

export type OpenInKind = "file-manager" | "editor" | "terminal";

export type OpenInPlatform = "mac" | "win" | "linux";

export interface OpenInApp {
  /** Stable id: persisted by the renderer and sent back over IPC. */
  id: string;
  label: string;
  kind: OpenInKind;
  /**
   * macOS bundle name (`/Applications/<appName>.app`), passed to `open -a`.
   * `dirFlag` is a CLI flag that takes the directory as its value, for
   * terminals that ignore a folder handed to them as an "open document"
   * event (Kitty, Alacritty): those launch a NEW instance with
   * `open -n -a <appName> --args <dirFlag> <dir>`.
   */
  mac?: { appName: string; dirFlag?: string };
  /**
   * Linux PATH binary, invoked as `<bin> <dir>` (or with `dirFlag`; a flag
   * ending in `=` is glued to the directory).
   */
  linux?: { bin: string; dirFlag?: string };
}

/** The catalog, in menu order (file manager, then editors, then terminals). */
export const OPEN_IN_APPS: readonly OpenInApp[] = [
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager",
    mac: { appName: "Finder" },
    linux: { bin: "xdg-open" },
  },
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor",
    mac: { appName: "Visual Studio Code" },
    linux: { bin: "code" },
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "editor",
    mac: { appName: "Cursor" },
    linux: { bin: "cursor" },
  },
  {
    id: "zed",
    label: "Zed",
    kind: "editor",
    mac: { appName: "Zed" },
    linux: { bin: "zed" },
  },
  {
    id: "zed-preview",
    label: "Zed Preview",
    kind: "editor",
    mac: { appName: "Zed Preview" },
  },
  {
    id: "sublime-text",
    label: "Sublime Text",
    kind: "editor",
    mac: { appName: "Sublime Text" },
    linux: { bin: "subl" },
  },
  { id: "xcode", label: "Xcode", kind: "editor", mac: { appName: "Xcode" } },
  {
    id: "android-studio",
    label: "Android Studio",
    kind: "editor",
    mac: { appName: "Android Studio" },
  },
  {
    id: "terminal",
    label: "Terminal",
    kind: "terminal",
    mac: { appName: "Terminal" },
  },
  // The bundle is "iTerm.app", not "iTerm2.app".
  {
    id: "iterm2",
    label: "iTerm2",
    kind: "terminal",
    mac: { appName: "iTerm" },
  },
  {
    id: "ghostty",
    label: "Ghostty",
    kind: "terminal",
    mac: { appName: "Ghostty" },
    linux: { bin: "ghostty", dirFlag: "--working-directory=" },
  },
  { id: "warp", label: "Warp", kind: "terminal", mac: { appName: "Warp" } },
  {
    id: "kitty",
    label: "Kitty",
    kind: "terminal",
    mac: { appName: "kitty", dirFlag: "--directory" },
    linux: { bin: "kitty", dirFlag: "--directory" },
  },
  {
    id: "alacritty",
    label: "Alacritty",
    kind: "terminal",
    mac: { appName: "Alacritty", dirFlag: "--working-directory" },
    linux: { bin: "alacritty", dirFlag: "--working-directory" },
  },
];

/** What the renderer gets: no launch details, just what it renders. */
export interface OpenInAppSummary {
  id: string;
  label: string;
  kind: OpenInKind;
}

export function currentOpenInPlatform(
  platform: NodeJS.Platform = process.platform,
): OpenInPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return "linux";
}

export function getOpenInApp(id: unknown): OpenInApp | undefined {
  if (typeof id !== "string" || id === "") return undefined;
  return OPEN_IN_APPS.find((app) => app.id === id);
}

/** The standard macOS application folders a bundle may live in. */
export function macAppCandidates(appName: string, homeDir: string): string[] {
  return [
    `/Applications/${appName}.app`,
    `${homeDir}/Applications/${appName}.app`,
    `/System/Applications/${appName}.app`,
    // Terminal.app and other built-ins live in Utilities.
    `/System/Applications/Utilities/${appName}.app`,
    // Finder lives here (it is always present on macOS).
    `/System/Library/CoreServices/${appName}.app`,
  ];
}

export interface AvailabilityProbes {
  platform: OpenInPlatform;
  homeDir: string;
  /** Does this absolute path exist? */
  exists: (path: string) => boolean;
  /** Does this binary resolve on PATH? */
  which: (bin: string) => boolean;
}

/**
 * Is `app` launchable on this host? macOS: its .app bundle exists in a
 * standard Applications folder (we launch via `open -a`, so a bundle is
 * what matters, not a CLI on PATH). Linux: its binary resolves on PATH.
 * Windows is not supported yet (nothing is available there).
 */
export function isOpenInAppAvailable(
  app: OpenInApp,
  probes: AvailabilityProbes,
): boolean {
  if (probes.platform === "mac") {
    const appName = app.mac?.appName;
    return (
      !!appName &&
      macAppCandidates(appName, probes.homeDir).some((p) => probes.exists(p))
    );
  }
  if (probes.platform === "linux") {
    return !!app.linux?.bin && probes.which(app.linux.bin);
  }
  return false;
}

export function availableOpenInApps(
  probes: AvailabilityProbes,
  catalog: readonly OpenInApp[] = OPEN_IN_APPS,
): OpenInAppSummary[] {
  return catalog
    .filter((app) => isOpenInAppAvailable(app, probes))
    .map(({ id, label, kind }) => ({ id, label, kind }));
}

export type OpenInArgv =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: string };

/**
 * The exact argv that opens directory `dir` in `app`. Pure.
 *
 * macOS:
 *   - every app, including Finder: `open -a <appName> <dir>` (editors open
 *     the folder as a project, terminals open a window in it, Finder opens
 *     the folder; `-a Finder` rather than bare `open <dir>` so a directory
 *     that happens to be a bundle, e.g. `foo.app`, is shown, never run),
 *   - terminals with a `dirFlag` (Kitty, Alacritty ignore an "open
 *     document" event for a folder): `open -n -a <appName> --args <flag> <dir>`.
 * Linux: `<bin> <dir>`, or `<bin> <flag> <dir>` / `<bin> <flag><dir>`.
 */
export function buildOpenInArgv(
  app: OpenInApp,
  dir: string,
  platform: OpenInPlatform,
): OpenInArgv {
  if (platform === "mac") {
    if (!app.mac)
      return { ok: false, error: `${app.label} is not available on macOS.` };
    const { appName, dirFlag } = app.mac;
    if (dirFlag)
      return {
        ok: true,
        command: "open",
        args: ["-n", "-a", appName, "--args", dirFlag, dir],
      };
    return { ok: true, command: "open", args: ["-a", appName, dir] };
  }
  if (platform === "linux") {
    if (!app.linux)
      return { ok: false, error: `${app.label} is not available on Linux.` };
    const { bin, dirFlag } = app.linux;
    if (!dirFlag) return { ok: true, command: bin, args: [dir] };
    return dirFlag.endsWith("=")
      ? { ok: true, command: bin, args: [`${dirFlag}${dir}`] }
      : { ok: true, command: bin, args: [dirFlag, dir] };
  }
  return { ok: false, error: "Open in… is not supported on this platform." };
}

export type OpenInResult = { ok: true } | { ok: false; error: string };

/** How long a launch may take to fail before it counts as launched. */
const LAUNCH_GRACE_MS = 2_000;
const STDERR_CAP_BYTES = 8_192;

/**
 * Spawn an argv launcher detached (its own process group, never keeping
 * this process alive) and wait at most LAUNCH_GRACE_MS for it to fail:
 * `open -a` exits 0 quickly on success and non-zero ("Unable to find
 * application named …") on failure; a launcher still running at the
 * deadline counts as launched. Mirrors Plannotator's `run`.
 */
export function runOpenInArgv(
  command: string,
  args: string[],
  label: string,
): Promise<OpenInResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    const finish = (result: OpenInResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const deadline = setTimeout(() => finish({ ok: true }), LAUNCH_GRACE_MS);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString();
    });
    child.once("error", (error) => {
      finish({
        ok: false,
        error: /ENOENT/.test(error.message)
          ? `${label} was not found on this system.`
          : error.message,
      });
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        error: `Failed to open ${label} (exit ${code ?? signal ?? "unknown"})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      });
    });
    child.unref();
  });
}
