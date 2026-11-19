// Installs the emulated cookie jar of frame-cookies-shim.ts in a loopback
// subframe (see there for why).
import { ipcRenderer, webFrame } from "electron";
import {
  cookieShim,
  FRAME_COOKIE_MESSAGE,
  FRAME_COOKIES_LOAD,
  FRAME_COOKIES_SET,
  isLoopbackPage,
  readCookieWrite,
} from "./frame-cookies-shim";

/**
 * Installs the emulated jar in this (sub)frame when it shows a loopback
 * page. Synchronous load, so the jar is in place before the page's own
 * scripts run.
 */
export function installFrameCookies(): void {
  if (!isLoopbackPage(window.location.href)) return;
  let initial: unknown;
  try {
    initial = ipcRenderer.sendSync(FRAME_COOKIES_LOAD);
  } catch {
    return;
  }
  if (typeof initial !== "object" || initial === null) return;
  void webFrame.executeJavaScript(
    `(${cookieShim.toString()})(${JSON.stringify(initial)}, ${JSON.stringify(
      FRAME_COOKIE_MESSAGE,
    )});`,
  );
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const write = readCookieWrite(event.data, FRAME_COOKIE_MESSAGE);
    if (write) ipcRenderer.send(FRAME_COOKIES_SET, write);
  });
}
