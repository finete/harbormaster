// Ported verbatim from pi-home's src/utilities/file-lock.ts.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  staleMs = 30_000,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        `${lockPath}/owner`,
        JSON.stringify({ pid: process.pid, at: Date.now() }),
      );
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await readFile(`${lockPath}/owner`);
      } catch {
        /* owner may be mid-write */
      }
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for state lock: ${lockPath}`);
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
