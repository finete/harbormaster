// Resource Access: fetches deployment-version documents over HTTPS. Ported
// from pi-home's src/access/http-version-access.ts unchanged in behavior:
// responses are cached for five minutes per URL so a frequently-polled
// refresh() stays cheap between deploys; failures are never cached, so the
// next refresh retries.

import type { VersionAccess } from "../contracts/github.js";

export class HttpVersionAccess implements VersionAccess {
  private readonly cache = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly get: typeof fetch = fetch,
  ) {}

  async fetchText(url: string): Promise<string> {
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const response = await this.get(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.8" },
    });
    if (!response.ok) {
      throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    }
    const value = (await response.text()).trim();
    this.cache.set(url, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}
