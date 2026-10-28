// Breadcrumb log for display trouble after sleep / lock / crashes:
// `<userData>/logs/wake.log`, rotated to `wake.log.1` past 512KB.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 512 * 1024;
/** Electron console-message level for `console.error`. */
const LEVEL_ERROR = 3;

/** Renderer console lines worth keeping: errors and our `[terminal]` lines. */
export function isWakeLogWorthy(level: number, message: string): boolean {
  return level >= LEVEL_ERROR || message.startsWith("[terminal]");
}

export function createWakeLog(path: string): (line: string) => void {
  let ready = false;
  return (line) => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true });
        ready = true;
      }
      try {
        if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
      } catch {}
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Diagnostics must never break the app.
    }
  };
}
