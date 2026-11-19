// Main's side of the URL pane's cookie jar (see preload/frame-cookies-shim.ts
// for why a loopback iframe can't keep its own cookies). One jar per host,
// shared across ports like real cookies; persistent cookies are saved to
// `<userData>/frame-cookies.json`, session cookies live until the app quits.
// It is browser-profile data (like Chromium's own cookie store in the same
// directory), not Harbormaster state, so it stays out of core.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IpcMain, IpcMainEvent } from "electron";
import {
  FRAME_COOKIE_MESSAGE,
  FRAME_COOKIES_LOAD,
  FRAME_COOKIES_SET,
  type FrameCookie,
  readCookieWrite,
} from "../preload/frame-cookies-shim";
import { isLoopbackUrl } from "./open-url";

export const FRAME_COOKIES_FILE = "frame-cookies.json";
export const MAX_COOKIES_PER_HOST = 300;
export const MAX_COOKIE_NAME = 256;
/** Chromium's per-cookie limit (name + value) is 4096 bytes. */
export const MAX_COOKIE_VALUE = 4096;

export type FrameCookieJarData = Record<string, Record<string, FrameCookie>>;

function isCookie(value: unknown): value is FrameCookie {
  if (typeof value !== "object" || value === null) return false;
  const { value: text, expires } = value as Record<string, unknown>;
  return (
    typeof text === "string" &&
    (expires === null ||
      (typeof expires === "number" && Number.isFinite(expires)))
  );
}

/** Tolerant: a missing or corrupt file is an empty jar. */
export function parseJarFile(text: string): FrameCookieJarData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const jar: FrameCookieJarData = {};
  if (typeof raw !== "object" || raw === null) return jar;
  for (const [host, cookies] of Object.entries(raw)) {
    if (typeof cookies !== "object" || cookies === null) continue;
    const kept: Record<string, FrameCookie> = {};
    for (const [name, cookie] of Object.entries(cookies)) {
      if (isCookie(cookie)) kept[name] = cookie;
    }
    jar[host] = kept;
  }
  return jar;
}

export class FrameCookieJar {
  private readonly hosts = new Map<string, Map<string, FrameCookie>>();

  constructor(
    initial: FrameCookieJarData = {},
    private readonly now: () => number = Date.now,
  ) {
    for (const [host, cookies] of Object.entries(initial)) {
      this.hosts.set(host, new Map(Object.entries(cookies)));
    }
  }

  /** The host's live cookies (expired ones are dropped). */
  snapshot(host: string): Record<string, FrameCookie> {
    const cookies = this.hosts.get(host);
    if (!cookies) return {};
    const now = this.now();
    const out: Record<string, FrameCookie> = {};
    for (const [name, cookie] of cookies) {
      if (cookie.expires !== null && cookie.expires <= now) {
        cookies.delete(name);
        continue;
      }
      out[name] = cookie;
    }
    return out;
  }

  /**
   * Sets (or, with `null`, deletes) one cookie. Returns whether the
   * persistent part changed; oversized writes and a full host are ignored.
   */
  set(host: string, name: string, cookie: FrameCookie | null): boolean {
    if (name.length > MAX_COOKIE_NAME) return false;
    let cookies = this.hosts.get(host);
    if (
      cookie === null ||
      (cookie.expires !== null && cookie.expires <= this.now())
    ) {
      const had = cookies?.get(name);
      cookies?.delete(name);
      return had !== undefined && had.expires !== null;
    }
    if (cookie.value.length > MAX_COOKIE_VALUE) return false;
    if (!cookies) {
      cookies = new Map();
      this.hosts.set(host, cookies);
    }
    const previous = cookies.get(name);
    if (!previous && cookies.size >= MAX_COOKIES_PER_HOST) return false;
    cookies.set(name, cookie);
    return cookie.expires !== null || (previous?.expires ?? null) !== null;
  }

  /** What gets saved: unexpired persistent cookies only. */
  toJSON(): FrameCookieJarData {
    const now = this.now();
    const out: FrameCookieJarData = {};
    for (const [host, cookies] of this.hosts) {
      const kept: Record<string, FrameCookie> = {};
      for (const [name, cookie] of cookies) {
        if (cookie.expires !== null && cookie.expires > now) {
          kept[name] = cookie;
        }
      }
      if (Object.keys(kept).length > 0) out[host] = kept;
    }
    return out;
  }
}

/**
 * The calling frame's host when it is a loopback page in a subframe; the
 * app's own top frame and anything else get no jar.
 */
export function senderHost(event: IpcMainEvent): string | null {
  const frame = event.senderFrame;
  if (!frame || frame.parent === null) return null;
  if (!isLoopbackUrl(frame.url)) return null;
  return new URL(frame.url).hostname;
}

const SAVE_DEBOUNCE_MS = 250;

/** Registers the jar's IPC; returns a flush for app quit. */
export function registerFrameCookieIpc(
  ipcMain: IpcMain,
  filePath: string,
): { flush: () => void } {
  let jar: FrameCookieJar | null = null;
  const load = (): FrameCookieJar => {
    if (!jar) {
      let text = "";
      try {
        text = readFileSync(filePath, "utf8");
      } catch {
        // No file yet.
      }
      jar = new FrameCookieJar(parseJarFile(text));
    }
    return jar;
  };

  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!jar) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(jar.toJSON()));
      renameSync(tmp, filePath);
    } catch (error) {
      console.error("[frame-cookies] save failed", error);
    }
  };

  ipcMain.on(FRAME_COOKIES_LOAD, (event) => {
    const host = senderHost(event);
    event.returnValue = host ? load().snapshot(host) : null;
  });
  ipcMain.on(FRAME_COOKIES_SET, (event, payload: unknown) => {
    const host = senderHost(event);
    if (!host) return;
    // Same shape the preload validated; re-checked here at the trust edge.
    const write = readCookieWrite(
      { ...(payload as object), [FRAME_COOKIE_MESSAGE]: true },
      FRAME_COOKIE_MESSAGE,
    );
    if (!write) return;
    if (!load().set(host, write.name, write.cookie)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  });

  return { flush };
}
