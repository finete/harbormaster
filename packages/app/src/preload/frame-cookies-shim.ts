// Cookies for agent-opened loopback pages in the task's URL pane (the
// Plannotator review tab, docs/plannotator.md decision 7).
//
// The pane is an <iframe> of http://localhost:<port> inside the app's
// file:// window, so Chromium treats it as a cross-site frame and drops
// every SameSite=Lax cookie it writes. Plannotator keeps all its UI
// settings in such cookies (cookies rather than localStorage because they
// survive its random port), so each review opened on the first-run setup
// screen again. This preload runs in loopback subframes
// (`nodeIntegrationInSubFrames`), replaces `document.cookie` in the page's
// world with a jar kept by main (main/frame-cookies.ts), keyed by host and
// shared across ports like real cookies. Electron-free, so main and the
// unit tests import it too; frame-cookies.ts installs it.
export const FRAME_COOKIES_LOAD = "frameCookies:load";
export const FRAME_COOKIES_SET = "frameCookies:set";
/** Marks the page-world → preload `postMessage` carrying one write. */
export const FRAME_COOKIE_MESSAGE = "__harbormasterFrameCookie";

export interface FrameCookie {
  value: string;
  /** Epoch ms; `null` = session cookie (kept until the app quits). */
  expires: number | null;
}

export interface FrameCookieWrite {
  name: string;
  /** `null` deletes the cookie. */
  cookie: FrameCookie | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether `url` is an http page on a loopback host (main checks again). */
export function isLoopbackPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Runs in the page's own world (serialized with `toString`, so it must stay
 * self-contained: no imports, no outer references). Replaces
 * `Document.prototype.cookie` with an emulated jar seeded from `initial`;
 * every write is posted to this window under `marker` for the preload to
 * forward to main. Path/domain/SameSite attributes are ignored: the jar is
 * per host already. Cookies the frame can still read natively are merged
 * in, ours winning on a name clash.
 */
export function cookieShim(
  initial: Record<string, { value: string; expires: number | null }>,
  marker: string,
): void {
  const store = new Map(Object.entries(initial));
  const native = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");

  function parse(
    raw: string,
    now: number,
  ): { name: string; value: string; expires: number | null } | null {
    const parts = raw.split(";");
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    const name = eq < 0 ? "" : first.slice(0, eq).trim();
    const value = (eq < 0 ? first : first.slice(eq + 1)).trim();
    if (!name && !value) return null;
    let expires: number | null = null;
    let fromMaxAge = false;
    for (const attribute of parts) {
      const at = attribute.indexOf("=");
      const key = (at < 0 ? attribute : attribute.slice(0, at))
        .trim()
        .toLowerCase();
      const raw = at < 0 ? "" : attribute.slice(at + 1).trim();
      if (key === "max-age" && /^-?\d+$/.test(raw)) {
        // Max-Age wins over Expires, whichever comes first (RFC 6265 5.3).
        expires = now + Number(raw) * 1000;
        fromMaxAge = true;
      } else if (key === "expires" && !fromMaxAge) {
        const at = Date.parse(raw);
        if (!Number.isNaN(at)) expires = at;
      }
    }
    return { name, value, expires };
  }

  Object.defineProperty(Document.prototype, "cookie", {
    configurable: true,
    enumerable: true,
    get(this: Document): string {
      const now = Date.now();
      const own: string[] = [];
      for (const [name, cookie] of store) {
        if (cookie.expires !== null && cookie.expires <= now) {
          store.delete(name);
          continue;
        }
        own.push(name ? `${name}=${cookie.value}` : cookie.value);
      }
      const nativeValue = native?.get ? String(native.get.call(this)) : "";
      const nativePairs = nativeValue
        .split(";")
        .map((pair) => pair.trim())
        .filter((pair) => {
          if (!pair) return false;
          const eq = pair.indexOf("=");
          return !store.has(eq < 0 ? "" : pair.slice(0, eq));
        });
      return [...nativePairs, ...own].join("; ");
    },
    set(this: Document, raw: unknown): void {
      const now = Date.now();
      const parsed = parse(String(raw), now);
      if (!parsed) return;
      const gone = parsed.expires !== null && parsed.expires <= now;
      const cookie = gone
        ? null
        : { value: parsed.value, expires: parsed.expires };
      if (cookie) store.set(parsed.name, cookie);
      else store.delete(parsed.name);
      window.postMessage({ [marker]: true, name: parsed.name, cookie }, "*");
    },
  });
}

/** Validates a page-world write message (the page itself can post these). */
export function readCookieWrite(
  data: unknown,
  marker: string,
): FrameCookieWrite | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record[marker] !== true || typeof record.name !== "string") return null;
  const cookie = record.cookie;
  if (cookie === null) return { name: record.name, cookie: null };
  if (typeof cookie !== "object" || cookie === undefined) return null;
  const { value, expires } = cookie as Record<string, unknown>;
  if (typeof value !== "string") return null;
  if (expires !== null && typeof expires !== "number") return null;
  return { name: record.name, cookie: { value, expires } };
}
