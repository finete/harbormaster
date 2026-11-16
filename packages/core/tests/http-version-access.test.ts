// Ported from pi-home's http-version-access coverage: a fake fetch never
// touches the network, cache behavior is exercised against a fake clock.

import { describe, expect, it, vi } from "vitest";
import { HttpVersionAccess } from "../src/access/http-version-access.js";
import { isConnectivityError } from "../src/engines/connectivity.js";

function fakeFetch(text: string, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    text: async () => text,
  })) as unknown as typeof fetch;
}

describe("HttpVersionAccess", () => {
  it("fetches and trims the response body", async () => {
    const fetchFn = fakeFetch("  v1.2.3+abcdef1  \n");
    const access = new HttpVersionAccess(5 * 60_000, 10_000, Date.now, fetchFn);
    await expect(access.fetchText("https://example.com/version")).resolves.toBe(
      "v1.2.3+abcdef1",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("caches per URL for the configured TTL, then refetches", async () => {
    let now = 0;
    const fetchFn = fakeFetch("v1+aaa");
    const access = new HttpVersionAccess(1000, 10_000, () => now, fetchFn);
    await access.fetchText("https://example.com/a");
    await access.fetchText("https://example.com/a");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 1001;
    await access.fetchText("https://example.com/a");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("never caches a failed fetch, so the next call retries", async () => {
    const fetchFn = fakeFetch("", false, 500);
    const access = new HttpVersionAccess(5 * 60_000, 10_000, Date.now, fetchFn);
    await expect(access.fetchText("https://example.com/down")).rejects.toThrow(
      "HTTP 500",
    );
    await expect(access.fetchText("https://example.com/down")).rejects.toThrow(
      "HTTP 500",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caches different URLs independently", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => ({
      ok: true,
      status: 200,
      text: async () => (url === "https://example.com/a" ? "v1+aaa" : "v2+bbb"),
    })) as unknown as typeof fetch;
    const access = new HttpVersionAccess(5 * 60_000, 10_000, Date.now, fetchFn);
    expect(await access.fetchText("https://example.com/a")).toBe("v1+aaa");
    expect(await access.fetchText("https://example.com/b")).toBe("v2+bbb");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // Node's fetch rejects every network failure as a bare "fetch failed"
  // (reason in `cause`) and its timeout as a TimeoutError; both must reach
  // the connectivity classifier with their reason so a wake from sleep is
  // the offline banner, not a per-task toast.
  function failingFetch(error: unknown): typeof fetch {
    return vi.fn(async () => {
      throw error;
    }) as unknown as typeof fetch;
  }

  function nodeFetchError(cause: unknown): TypeError {
    return new TypeError("fetch failed", { cause });
  }

  function codeError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  it.each([
    [
      "DNS failure",
      nodeFetchError(
        codeError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com"),
      ),
      "fetch failed (getaddrinfo ENOTFOUND api.example.com)",
    ],
    [
      "unreachable network",
      nodeFetchError(
        codeError("ENETUNREACH", "connect ENETUNREACH 10.0.0.1:443"),
      ),
      "fetch failed (connect ENETUNREACH 10.0.0.1:443)",
    ],
    [
      "undici connect timeout",
      nodeFetchError(
        codeError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"),
      ),
      "fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)",
    ],
    [
      "both address families refused",
      nodeFetchError(
        Object.assign(
          new AggregateError([
            codeError("ECONNREFUSED", "connect ECONNREFUSED ::1:443"),
            codeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"),
          ]),
          { code: "ECONNREFUSED" },
        ),
      ),
      "fetch failed (connect ECONNREFUSED ::1:443)",
    ],
    [
      "request timeout",
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
      "timed out after 10000ms (ETIMEDOUT)",
    ],
  ])(
    "surfaces the reason for a %s as a connectivity failure",
    async (_name, error, reason) => {
      const access = new HttpVersionAccess(
        5 * 60_000,
        10_000,
        Date.now,
        failingFetch(error),
      );
      const failure = await access
        .fetchText("https://example.com/version")
        .then(
          () => undefined,
          (caught: unknown) => caught as Error,
        );
      expect(failure?.message).toBe(
        `GET https://example.com/version failed: ${reason}`,
      );
      expect(failure?.cause).toBe(error);
      expect(isConnectivityError(failure?.message ?? "")).toBe(true);
    },
  );

  it("keeps a non-network fetch failure out of the connectivity class", async () => {
    const error = nodeFetchError(
      codeError("CERT_HAS_EXPIRED", "certificate has expired"),
    );
    const access = new HttpVersionAccess(
      5 * 60_000,
      10_000,
      Date.now,
      failingFetch(error),
    );
    const failure = await access.fetchText("https://example.com/version").then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(failure?.message).toBe(
      "GET https://example.com/version failed: fetch failed (CERT_HAS_EXPIRED: certificate has expired)",
    );
    expect(isConnectivityError(failure?.message ?? "")).toBe(false);
  });
});
