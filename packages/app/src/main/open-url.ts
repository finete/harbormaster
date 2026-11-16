// Agent-opened local URLs (docs/plannotator.md): where the open-url handler
// script lives (exported to sessions as PLANNOTATOR_BROWSER through the
// harness adapter), the loopback check every in-app URL must pass, and the
// HEAD probe the review tab polls to notice a Plannotator server is gone.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const OPEN_URL_HANDLER_FILE = "harbormaster-open-url";

export interface OpenUrlHandlerContext {
  isPackaged: boolean;
  /** `process.resourcesPath` (packaged app's Contents/Resources). */
  resourcesPath: string;
  /** The main bundle's directory (`__dirname`: `packages/app/out/main` in development). */
  mainDir: string;
  exists?: (path: string) => boolean;
}

/**
 * The absolute path of `harbormaster-open-url`: bundled next to the
 * `harbormaster` launcher (`Contents/Resources/bin`, electron-builder.yml
 * `extraResources`) when packaged, `packages/app/resources/bin` in
 * development. `undefined` when missing: sessions then launch without a
 * handler and the pty fallback watches for Plannotator's ready line.
 */
export function resolveOpenUrlHandler(
  context: OpenUrlHandlerContext,
): string | undefined {
  const exists = context.exists ?? existsSync;
  const path = context.isPackaged
    ? join(context.resourcesPath, "bin", OPEN_URL_HANDLER_FILE)
    : join(
        context.mainDir,
        "..",
        "..",
        "resources",
        "bin",
        OPEN_URL_HANDLER_FILE,
      );
  return exists(path) ? path : undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Only `http://` URLs on a loopback host are ever shown in-app. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a loopback URL's server still answers: any HTTP response counts
 * (a 404/405 to HEAD is still a live server); a refused connection or a
 * timeout does not. Never fetches a non-loopback URL.
 */
export async function probeLoopbackUrl(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  if (!isLoopbackUrl(url)) return false;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    await fetchImpl(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    return true;
  } catch {
    return false;
  }
}
