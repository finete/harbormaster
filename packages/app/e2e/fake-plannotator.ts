import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What the fake prints for `--version` (above every minimum in docs/plannotator.md). */
export const FAKE_PLANNOTATOR_VERSION = "0.28.64";

/**
 * A stand-in `plannotator` (a node script) honouring the four facts the
 * app relies on (docs/plannotator.md "What we rely on from Plannotator"):
 * `--version` prints a semver; `review` serves a tiny frameable page on a
 * random 127.0.0.1 port, prints `Plannotator session ready: <url>` on
 * stderr first, then runs `$PLANNOTATOR_BROWSER <url>` when set; it exits
 * once the page POSTs `/send` (the user sent their feedback), so the
 * server is gone exactly like a real session's. The page shows "first run"
 * until it finds the settings cookie it sets (Plannotator keeps its settings
 * in SameSite=Lax cookies). `GET`/`POST /api/draft` hold the unsent-comment
 * draft and `POST /api/exit` (no Origin) closes the session like the page's
 * Close (contract facts 5 and 6). Written as `<binDir>/plannotator`.
 */
export function writeFakePlannotator(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "plannotator");
  const script = String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const http = require("node:http");
const [command] = process.argv.slice(2);
if (command === "--version") {
  process.stdout.write("${FAKE_PLANNOTATOR_VERSION}\n");
  process.exit(0);
}
if (command !== "review") {
  process.stderr.write("fake plannotator: unknown command " + command + "\n");
  process.exit(1);
}
const PAGE = '<!doctype html><html><body style="background:#fff;color:#111">' +
  '<h1 data-testid="fake-plannotator-title">Fake Plannotator review</h1>' +
  '<button id="send" onclick="fetch(\'/send\',{method:\'POST\'}).then(function(){document.getElementById(\'sent\').textContent=\'sent\'})">Send feedback</button>' +
  '<p id="sent"></p>' +
  // Like Plannotator's settings: a SameSite=Lax cookie it must find again
  // in the next session, on a new port.
  '<p data-testid="fake-plannotator-seen"></p><script>' +
  'document.querySelector("[data-testid=fake-plannotator-seen]").textContent = /(?:^|; )plannotator-seen=1/.test(document.cookie) ? "remembered" : "first run";' +
  'document.cookie = "plannotator-seen=1; path=/; max-age=31536000; SameSite=Lax";' +
  '</script></body></html>';
let draft = null;
const server = http.createServer((req, res) => {
  // The autosaved draft (contract fact 5): what closing the tab would lose.
  if (req.url === "/api/draft") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        draft = JSON.parse(body);
        res.end('{"ok":true}');
      });
      return;
    }
    if (draft === null) {
      // No draft yet: 204 and no body, like Plannotator 0.29+ (0.28.x sent
      // 404 {"found": false}; the app accepts both).
      res.statusCode = 204;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(draft));
    return;
  }
  // The page's own Close (contract fact 6): refused from a browser page on
  // another site, like Plannotator's cross-origin write guard.
  if (req.method === "POST" && req.url === "/api/exit") {
    if (req.headers.origin) {
      res.statusCode = 403;
      res.end();
      return;
    }
    res.end('{"ok":true}');
    process.stdout.write("Review session closed without feedback.\n");
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (req.method === "POST" && req.url === "/send") {
    res.end("ok");
    // Like a real session: the feedback goes to the agent, the server ends.
    setTimeout(() => process.exit(0), 50);
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(req.method === "HEAD" ? undefined : PAGE);
});
server.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port + "/";
  process.stderr.write("Plannotator session ready: " + url + "\n");
  const browser = process.env.PLANNOTATOR_BROWSER;
  if (browser) spawn(browser, [url], { stdio: "inherit" });
});
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

/**
 * A stand-in macOS `open` (first on PATH) that only records its arguments:
 * the open-url script's system-browser fallback must never reach a real
 * browser from a test.
 */
export function writeFakeOpen(binDir: string, logFile: string): void {
  mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "open");
  writeFileSync(file, `#!/bin/sh\necho "$@" >> "${logFile}"\n`);
  chmodSync(file, 0o755);
}
