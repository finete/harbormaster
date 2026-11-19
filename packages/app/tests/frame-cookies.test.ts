// The URL pane's emulated cookie jar (preload/frame-cookies-shim.ts and
// main/frame-cookies.ts): Plannotator's settings cookies, which Chromium
// drops in a cross-site iframe, survive a new session on another port.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FrameCookieJar,
  MAX_COOKIES_PER_HOST,
  parseJarFile,
} from "../src/main/frame-cookies";
import {
  cookieShim,
  FRAME_COOKIE_MESSAGE,
  type FrameCookie,
  readCookieWrite,
} from "../src/preload/frame-cookies-shim";

describe("cookieShim (run from its serialized source, as the preload does)", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  let saved: { Document: unknown; window: unknown };
  let posted: unknown[];

  interface FakeDocument {
    /** What a cross-site frame still reads natively. */
    native: string;
    cookie: string;
  }

  function install(initial: Record<string, FrameCookie> = {}): FakeDocument {
    // A fresh class per test: the shim patches its prototype.
    class FakeDocumentImpl {
      native = "";
      get cookie(): string {
        return this.native;
      }
      set cookie(_value: string) {
        // Chromium drops the SameSite=Lax write.
      }
    }
    globals.Document = FakeDocumentImpl;
    new Function(
      "initial",
      "marker",
      `(${cookieShim.toString()})(initial, marker);`,
    )(initial, FRAME_COOKIE_MESSAGE);
    return new FakeDocumentImpl() as FakeDocument;
  }

  beforeEach(() => {
    saved = { Document: globals.Document, window: globals.window };
    posted = [];
    globals.window = { postMessage: (data: unknown) => posted.push(data) };
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    globals.Document = saved.Document;
    globals.window = saved.window;
    vi.useRealTimers();
  });

  it("reads the seeded jar and posts each write for main", () => {
    const doc = install({
      "plannotator-theme": { value: "dark", expires: null },
    });
    expect(doc.cookie).toBe("plannotator-theme=dark");

    doc.cookie =
      "plannotator-plan-look-v2=resolved; path=/; max-age=31536000; SameSite=Lax";
    expect(doc.cookie).toBe(
      "plannotator-theme=dark; plannotator-plan-look-v2=resolved",
    );
    expect(posted).toEqual([
      {
        [FRAME_COOKIE_MESSAGE]: true,
        name: "plannotator-plan-look-v2",
        cookie: { value: "resolved", expires: 1_000_000 + 31_536_000_000 },
      },
    ]);
    expect(readCookieWrite(posted[0], FRAME_COOKIE_MESSAGE)).toEqual({
      name: "plannotator-plan-look-v2",
      cookie: { value: "resolved", expires: 1_000_000 + 31_536_000_000 },
    });
  });

  it("deletes on max-age=0 or a past Expires, and drops expired entries on read", () => {
    const doc = install({
      a: { value: "1", expires: null },
      b: { value: "2", expires: null },
      soon: { value: "3", expires: 1_000_500 },
    });
    doc.cookie = "a=; path=/; max-age=0";
    doc.cookie = "b=x; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(doc.cookie).toBe("soon=3");
    vi.setSystemTime(1_000_500);
    expect(doc.cookie).toBe("");
    expect(posted).toMatchObject([
      { name: "a", cookie: null },
      { name: "b", cookie: null },
    ]);
  });

  it("keeps natively readable cookies, the jar winning a name clash", () => {
    const doc = install({ shared: { value: "ours", expires: null } });
    doc.native = "other=1; shared=theirs";
    expect(doc.cookie).toBe("other=1; shared=ours");
  });

  it("rejects malformed write messages", () => {
    expect(readCookieWrite({ name: "x", cookie: null }, "m")).toBeNull();
    expect(
      readCookieWrite({ m: true, name: "x", cookie: { value: 1 } }, "m"),
    ).toBeNull();
    expect(
      readCookieWrite(
        { m: true, name: "x", cookie: { value: "v", expires: "soon" } },
        "m",
      ),
    ).toBeNull();
  });
});

describe("FrameCookieJar", () => {
  const now = () => 5_000;

  it("keeps a jar per host, shared across ports", () => {
    const jar = new FrameCookieJar({}, now);
    jar.set("localhost", "k", { value: "v", expires: 10_000 });
    expect(jar.snapshot("localhost")).toEqual({
      k: { value: "v", expires: 10_000 },
    });
    expect(jar.snapshot("127.0.0.1")).toEqual({});
  });

  it("saves only unexpired persistent cookies, and reloads them", () => {
    const jar = new FrameCookieJar({}, now);
    expect(jar.set("localhost", "kept", { value: "1", expires: 9_000 })).toBe(
      true,
    );
    expect(jar.set("localhost", "session", { value: "2", expires: null })).toBe(
      false,
    );
    const saved = JSON.stringify(jar.toJSON());
    expect(JSON.parse(saved)).toEqual({
      localhost: { kept: { value: "1", expires: 9_000 } },
    });
    expect(
      new FrameCookieJar(parseJarFile(saved), now).snapshot("localhost"),
    ).toEqual({ kept: { value: "1", expires: 9_000 } });
    expect(jar.set("localhost", "kept", null)).toBe(true);
    expect(jar.toJSON()).toEqual({});
  });

  it("ignores oversized values and a full host", () => {
    const jar = new FrameCookieJar({}, now);
    expect(
      jar.set("localhost", "big", { value: "x".repeat(5000), expires: 9_000 }),
    ).toBe(false);
    for (let i = 0; i < MAX_COOKIES_PER_HOST; i++) {
      jar.set("localhost", `k${i}`, { value: "v", expires: 9_000 });
    }
    expect(
      jar.set("localhost", "one-more", { value: "v", expires: 9_000 }),
    ).toBe(false);
    expect(jar.set("localhost", "k0", { value: "w", expires: 9_000 })).toBe(
      true,
    );
  });

  it("treats a corrupt file as an empty jar", () => {
    expect(parseJarFile("{nope")).toEqual({});
    expect(
      parseJarFile(
        JSON.stringify({
          localhost: { ok: { value: "1", expires: 1 }, bad: 3 },
        }),
      ),
    ).toEqual({ localhost: { ok: { value: "1", expires: 1 } } });
  });
});
