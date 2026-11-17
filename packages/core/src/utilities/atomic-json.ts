// Ported verbatim from pi-home's src/utilities/atomic-json.ts.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string, fallback: () => T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw error;
  }
}

/** Write `value` as pretty JSON via temp file + rename; resolves to the exact text written. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
  return text;
}
