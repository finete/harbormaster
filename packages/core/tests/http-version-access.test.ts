// Ported from pi-home's http-version-access coverage: a fake fetch never
// touches the network, cache behavior is exercised against a fake clock.

import { describe, expect, it, vi } from "vitest";
import { HttpVersionAccess } from "../src/access/http-version-access.js";

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
});
