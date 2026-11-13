/**
 * Clipboard paste resolution for terminal panes (checklist items #1, #2).
 *
 * Priority order (native macOS terminal paste parity):
 *   1. File URLs (NSFilenamesPboardType or public.file-url) → shell-escaped path(s)
 *   2. Plain text → raw text (no escaping; brackets handled by xterm.paste)
 *   3. Image → write PNG to tmpdir, return shell-escaped path
 *   4. Nothing → null
 *
 * The function is injectable so it can be unit-tested without a real clipboard or fs.
 */

import { fileURLToPath } from "node:url";
import { shellEscapePath, shellEscapePaths } from "../shared/shell-escape";

// --- Injected dependencies (real implementations used at runtime) ---

export interface ClipboardDeps {
  /** electron clipboard.availableFormats() */
  availableFormats(): string[];
  /** electron clipboard.read(format) */
  read(format: string): string;
  /** electron clipboard.readText() */
  readText(): string;
  /** electron clipboard.readImage() */
  readImage(): { isEmpty(): boolean; toPNG(): Buffer };
}

export interface FsDeps {
  writeFileSync(path: string, data: Buffer, options: { mode: number }): void;
  existsSync(path: string): boolean;
}

export interface ClipboardPasteOptions {
  clipboard: ClipboardDeps;
  fs: FsDeps;
  /** os.tmpdir() — injectable so tests don't write to the real tmp. */
  tmpdir: string;
  /** Date object for the timestamp — injectable for deterministic tests. */
  now: Date;
  /** UUID generator — injectable for deterministic tests. */
  uuid: () => string;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Parse a simple macOS plist `<string>…</string>` list as returned by
 * `clipboard.read("NSFilenamesPboardType")`.  This avoids a plist parser
 * dependency; Hyper uses the same regex approach.
 */
function parsePlistStrings(plist: string): string[] {
  const matches = plist.matchAll(/<string>([^<]*)<\/string>/g);
  return Array.from(matches, (m) => m[1]).filter((s): s is string =>
    Boolean(s),
  );
}

/**
 * Resolve what to paste when the user hits Cmd+V in a terminal pane.
 *
 * Returns the string to hand to `terminal.paste(…)`, or null if the
 * clipboard holds nothing pasteable (empty or an oversized image).
 */
export function resolveClipboardPaste(
  deps: ClipboardPasteOptions,
): string | null {
  const { clipboard, fs, tmpdir, now, uuid } = deps;

  // --- 1. File URLs ---
  const formats = clipboard.availableFormats();

  // macOS puts Finder-copied file paths as NSFilenamesPboardType (a plist).
  const finderPlist = clipboard.read("NSFilenamesPboardType");
  if (finderPlist) {
    const paths = parsePlistStrings(finderPlist).filter(
      (p): p is string => Boolean(p) && fs.existsSync(p),
    );
    if (paths.length > 0) return shellEscapePaths(paths);
  }

  // Fallback: public.file-url or text/uri-list (single URL).
  if (
    formats.includes("public.file-url") ||
    formats.includes("text/uri-list")
  ) {
    const raw =
      clipboard.read("public.file-url") || clipboard.read("text/uri-list");
    if (raw) {
      try {
        const firstLine = raw.trim().split("\n")[0]?.trim() ?? "";
        const filePath = fileURLToPath(firstLine);
        if (fs.existsSync(filePath)) return shellEscapePath(filePath);
      } catch {
        // Not a valid file URL; fall through.
      }
    }
  }

  // --- 2. Plain text ---
  const text = clipboard.readText();
  if (text) return text;

  // --- 3. Image ---
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const png = img.toPNG();
    if (png.length > MAX_IMAGE_BYTES) return null; // cap: 10 MB

    // Filename: clipboard-<YYYY>-<MM>-<DD>-<HHmmss>-<FIRST8HEX>.png
    // Use local time with zero-padded en-US digits.
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const h = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");
    const suffix = uuid().replace(/-/g, "").slice(0, 8).toUpperCase();
    const filename = `clipboard-${y}-${mo}-${d}-${h}${mi}${s}-${suffix}.png`;
    const filePath = `${tmpdir}/${filename}`;

    fs.writeFileSync(filePath, png, { mode: 0o600 });
    return shellEscapePath(filePath);
  }

  // --- 4. Nothing ---
  return null;
}
