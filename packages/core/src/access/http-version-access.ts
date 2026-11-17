// Resource Access: fetches deployment-version documents over HTTPS. Ported
// from pi-home's src/access/http-version-access.ts unchanged in behavior:
// responses are cached for five minutes per URL so a frequently-polled
// refresh() stays cheap between deploys; failures are never cached, so the
// next refresh retries.
//
// Network failures are rethrown with their cause in the message: Node's
// fetch reports every one as a bare "fetch failed" (the real reason, e.g.
// `getaddrinfo ENOTFOUND`, sits in `error.cause`) and its timeout as "The
// operation was aborted due to timeout", neither of which the connectivity
// classifier (engines/connectivity.ts) can recognize. Without the cause, a
// laptop waking from sleep becomes a per-task warning toast instead of the
// offline banner.

import type { VersionAccess } from "../contracts/github.js";
import { LruMap } from "../utilities/lru-map.js";
import {
  isUntrustedCertificateError,
  TLS_TRUST_HINT,
} from "../utilities/tls-trust.js";

export class HttpVersionAccess implements VersionAccess {
  /** LRU-capped: keyed by URL, so bounded in practice, but never unbounded. */
  private readonly cache = new LruMap<
    string,
    { value: string; expiresAt: number }
  >(200);

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly get: typeof fetch = fetch,
  ) {}

  async fetchText(url: string): Promise<string> {
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    let response: Response;
    try {
      response = await this.get(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.8" },
      });
    } catch (error) {
      throw new Error(
        `GET ${url} failed: ${describeFetchError(error, this.timeoutMs)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    }
    const value = (await response.text()).trim();
    this.cache.set(url, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}

/**
 * One line for a rejected fetch: the timeout as `timed out after Nms
 * (ETIMEDOUT)`, otherwise the message plus its cause's code and message
 * (`fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND host)`). An
 * AggregateError cause (both address families refused) contributes its
 * first inner error.
 */
export function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `timed out after ${timeoutMs}ms (ETIMEDOUT)`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? describeCause(error.cause) : undefined;
  const text = cause ? `${message} (${cause})` : message;
  return isUntrustedCertificateError(text)
    ? `${text}; ${TLS_TRUST_HINT}`
    : text;
}

function describeCause(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) {
    return typeof cause === "string" && cause ? cause : undefined;
  }
  const inner: unknown =
    cause instanceof AggregateError ? cause.errors[0] : undefined;
  const source = !cause.message && inner instanceof Error ? inner : cause;
  const code = errorCode(source) ?? errorCode(cause);
  const text = source.message;
  if (code && text && !text.includes(code)) return `${code}: ${text}`;
  return text || code;
}

function errorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
