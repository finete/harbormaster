/**
 * IPC handlers for the terminalHost preload API (checklist Chunk 0, A, E).
 *
 * - terminalHost:resolveClipboardPaste  → clipboard image/file/text paste (P0)
 * - terminalHost:openLink               → http/https link open (P1)
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { ipcMain, shell } from "electron";
import { appClipboard } from "./app-clipboard";
import { resolveClipboardPaste } from "./clipboard-paste";

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Register all terminalHost IPC handlers.  Call once from main/index.ts after
 * the app is ready.
 */
export function registerTerminalHostIpc(): void {
  // --- Clipboard paste resolution (items #1, #2) ---
  ipcMain.handle(
    "terminalHost:resolveClipboardPaste",
    async (): Promise<string | null> => {
      return resolveClipboardPaste({
        clipboard: {
          availableFormats: () => appClipboard.availableFormats(),
          read: (format) => appClipboard.read(format),
          readText: () => appClipboard.readText(),
          readImage: () => appClipboard.readImage(),
        },
        fs: { writeFileSync, existsSync },
        tmpdir: os.tmpdir(),
        now: new Date(),
        uuid: () => crypto.randomUUID(),
      });
    },
  );

  // --- Link open (item #10, #11): http/https only ---
  ipcMain.handle(
    "terminalHost:openLink",
    async (_event, url: unknown): Promise<boolean> => {
      if (!isHttpUrl(url)) return false;

      // E2E sink: when set, write the URL to a file instead of opening it.
      const sink = process.env.HARBORMASTER_E2E_LINK_SINK;
      if (sink) {
        try {
          appendFileSync(sink, `${url}\n`);
        } catch {
          // Ignore write errors in tests.
        }
        return true;
      }

      try {
        await shell.openExternal(url);
        return true;
      } catch {
        return false;
      }
    },
  );
}
