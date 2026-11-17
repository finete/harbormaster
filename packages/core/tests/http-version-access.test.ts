// Ported from pi-home's http-version-access coverage: a fake fetch never
// touches the network, cache behavior is exercised against a fake clock.

import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpVersionAccess } from "../src/access/http-version-access.js";
import { isConnectivityError } from "../src/engines/connectivity.js";
import { TLS_TRUST_HINT } from "../src/utilities/tls-trust.js";

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

  it.each([
    [
      "Node",
      nodeFetchError(
        codeError(
          "SELF_SIGNED_CERT_IN_CHAIN",
          "self signed certificate in certificate chain",
        ),
      ),
      "fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self signed certificate in certificate chain)",
    ],
    [
      "Electron net.fetch",
      new Error("net::ERR_CERT_AUTHORITY_INVALID"),
      "net::ERR_CERT_AUTHORITY_INVALID",
    ],
  ])(
    "names an untrusted certificate from %s and keeps it out of the connectivity class",
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
        `GET https://example.com/version failed: ${reason}; ${TLS_TRUST_HINT}`,
      );
      expect(isConnectivityError(failure?.message ?? "")).toBe(false);
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

// The same failures through Node's REAL fetch (no mock): local sockets that
// refuse, reset or stall, and a name that never resolves. A mock only
// encodes what we believe fetch throws; this pins what it actually throws
// (the mock above once threw a shape Node never produces).
describe("HttpVersionAccess against real sockets", () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function listen(
    onConnection: (socket: Socket) => void,
  ): Promise<number> {
    const server = createServer((socket) => {
      sockets.push(socket);
      onConnection(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  async function failure(url: string, timeoutMs = 2_000): Promise<string> {
    const access = new HttpVersionAccess(1, timeoutMs);
    return access.fetchText(url).then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );
  }

  it("connection refused", async () => {
    // Bind then close: the port is known-free, nothing listens.
    const port = await listen(() => {});
    await new Promise((resolve) => servers.pop()?.close(resolve));
    const message = await failure(`http://127.0.0.1:${port}/version`);
    expect(message).toMatch(/ECONNREFUSED/);
    expect(isConnectivityError(message)).toBe(true);
  });

  it("connection reset mid-request", async () => {
    const port = await listen((socket) => socket.resetAndDestroy());
    const message = await failure(`http://127.0.0.1:${port}/version`);
    expect(message).toMatch(/ECONNRESET|socket hang up|other side closed/i);
    expect(isConnectivityError(message)).toBe(true);
  });

  it("a server that accepts and never answers times out", async () => {
    const port = await listen(() => {});
    const message = await failure(`http://127.0.0.1:${port}/version`, 300);
    expect(message).toContain("timed out after 300ms");
    expect(isConnectivityError(message)).toBe(true);
  });

  it("a name that never resolves", async () => {
    const message = await failure("https://harbormaster-test.invalid/version");
    expect(message).toMatch(/ENOTFOUND|EAI_AGAIN/);
    expect(isConnectivityError(message)).toBe(true);
  });
});
