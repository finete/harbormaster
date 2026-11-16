// The open-url handler path (packaged vs dev), the loopback-only rule and
// the HEAD probe behind the review tab's "server gone" placeholder
// (main/open-url.ts, docs/plannotator.md).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLoopbackUrl,
  probeLoopbackUrl,
  resolveOpenUrlHandler,
} from "../src/main/open-url";

describe("resolveOpenUrlHandler", () => {
  it("uses Contents/Resources/bin when packaged", () => {
    expect(
      resolveOpenUrlHandler({
        isPackaged: true,
        resourcesPath: "/Applications/Harbormaster.app/Contents/Resources",
        mainDir: "/ignored",
        exists: () => true,
      }),
    ).toBe(
      "/Applications/Harbormaster.app/Contents/Resources/bin/harbormaster-open-url",
    );
  });

  it("uses packages/app/resources/bin in development, and the file exists", () => {
    const mainDir = join(__dirname, "..", "out", "main");
    expect(
      resolveOpenUrlHandler({
        isPackaged: false,
        resourcesPath: "/ignored",
        mainDir,
      }),
    ).toBe(join(__dirname, "..", "resources", "bin", "harbormaster-open-url"));
  });

  it("is undefined when the script is missing", () => {
    expect(
      resolveOpenUrlHandler({
        isPackaged: true,
        resourcesPath: "/nowhere",
        mainDir: "/nowhere",
        exists: () => false,
      }),
    ).toBeUndefined();
  });
});

describe("isLoopbackUrl", () => {
  it.each([
    "http://127.0.0.1:4321/",
    "http://localhost:3000/review?x=1",
    "http://[::1]:8080/",
  ])("accepts %s", (url) => expect(isLoopbackUrl(url)).toBe(true));
  it.each([
    "https://github.com/",
    "http://example.com/",
    "http://127.0.0.1.evil.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s", (url) => expect(isLoopbackUrl(url)).toBe(false));
});

describe("probeLoopbackUrl", () => {
  it("is true while the server answers (any status) and false once it is gone", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 405;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    expect(await probeLoopbackUrl(url)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeLoopbackUrl(url, { timeoutMs: 500 })).toBe(false);
  });

  it("never fetches a non-loopback URL", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response();
    }) as typeof fetch;
    expect(await probeLoopbackUrl("https://example.com/", { fetchImpl })).toBe(
      false,
    );
    expect(called).toBe(false);
  });
});

describe("resources/bin/harbormaster-open-url", () => {
  const script = join(
    __dirname,
    "..",
    "resources",
    "bin",
    "harbormaster-open-url",
  );

  function run(
    url: string,
    cliExit: number,
    extraEnv: Record<string, string> = {},
  ): { code: number; log: string } {
    const dir = mkdtempSync(join(tmpdir(), "hm-open-url-"));
    try {
      const log = join(dir, "log");
      const cli = join(dir, "cli");
      writeFileSync(
        cli,
        `#!/bin/sh\necho "cli $*" >> "${log}"\nexit ${cliExit}\n`,
      );
      chmodSync(cli, 0o755);
      // A fake `open` first on PATH: the real one must never run here.
      writeFileSync(
        join(dir, "open"),
        `#!/bin/sh\necho "open $*" >> "${log}"\n`,
      );
      chmodSync(join(dir, "open"), 0o755);
      let code = 0;
      try {
        execFileSync(script, [url], {
          env: {
            PATH: `${dir}:/usr/bin:/bin`,
            HARBORMASTER_CLI: cli,
            ...extraEnv,
          },
          stdio: "ignore",
        });
      } catch (error) {
        code = (error as { status: number }).status;
      }
      let text = "";
      try {
        text = execFileSync("cat", [log], { encoding: "utf8" });
      } catch {
        text = "";
      }
      return { code, log: text };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("hands the URL to the app as Plannotator's and stops there when it answers", () => {
    expect(run("http://127.0.0.1:5000/", 0)).toEqual({
      code: 0,
      log: "cli open-url http://127.0.0.1:5000/ --source plannotator\n",
    });
  });

  it("claims nothing when it is also the agent's BROWSER (captureAgentBrowser)", () => {
    expect(run("http://127.0.0.1:5000/", 0, { BROWSER: script })).toEqual({
      code: 0,
      log: "cli open-url http://127.0.0.1:5000/\n",
    });
  });

  it("falls back to the system browser when the app is down", () => {
    expect(run("http://127.0.0.1:5000/", 1)).toEqual({
      code: 0,
      log: "cli open-url http://127.0.0.1:5000/ --source plannotator\nopen http://127.0.0.1:5000/\n",
    });
  });

  it("refuses a non-http(s) URL and opens nothing", () => {
    expect(run("file:///etc/passwd", 0)).toEqual({ code: 2, log: "" });
  });
});
