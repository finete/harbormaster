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

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
