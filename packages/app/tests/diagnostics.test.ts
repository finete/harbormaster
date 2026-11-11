import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDiagnosticsZip,
  collectLogEntries,
  diagnosticsFileName,
  REDACTED,
  redactConfig,
  redactString,
} from "../src/main/diagnostics";
import { crc32, createZip } from "../src/main/zip-writer";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hm-diagnostics-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function unzipList(zipPath: string): string[] {
  return execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .trim()
    .split("\n");
}

function unzipRead(zipPath: string, name: string): string {
  return execFileSync("unzip", ["-p", zipPath, name], { encoding: "utf8" });
}

describe("redactString", () => {
  it("strips credentials embedded in URLs", () => {
    expect(redactString("https://alice:hunter2@github.com/acme/app.git")).toBe(
      `https://${REDACTED}@github.com/acme/app.git`,
    );
    expect(redactString("https://x-access-token@ghe.example/acme")).toBe(
      `https://${REDACTED}@ghe.example/acme`,
    );
    expect(
      redactString("https://deploy.example/version?token=abc123&x=1"),
    ).toBe(`https://deploy.example/version?token=${REDACTED}&x=1`);
  });

  it("redacts known token shapes anywhere in text", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactString(`export GH=${token} done`)).toBe(
      `export GH=${REDACTED} done`,
    );
    expect(redactString(`key sk-ant-${"b".repeat(30)}`)).toBe(
      `key ${REDACTED}`,
    );
  });

  it("leaves ordinary URLs and paths alone", () => {
    for (const plain of [
      "https://deploy.example/version.txt",
      "/Users/alice/Code",
      "git@github.com:acme/app.git",
    ]) {
      expect(redactString(plain)).toBe(plain);
    }
  });
});

describe("redactConfig", () => {
  it("redacts secret-named keys deeply and keeps the rest readable", () => {
    const config = {
      automation: true,
      codeRoot: "/Users/alice/Code",
      repositories: {
        "github.com/acme/app": {
          deployment: [
            {
              name: "staging",
              versionUrl: "https://bob:pw@staging.example/version",
            },
          ],
          githubToken: "anything",
        },
      },
      addons: { slack: { apiKey: "xyz", webhook: { secret: 42 } } },
      launch: { maxConcurrent: 6 },
    };
    expect(redactConfig(config)).toEqual({
      automation: true,
      codeRoot: "/Users/alice/Code",
      repositories: {
        "github.com/acme/app": {
          deployment: [
            {
              name: "staging",
              versionUrl: `https://${REDACTED}@staging.example/version`,
            },
          ],
          githubToken: REDACTED,
        },
      },
      addons: { slack: { apiKey: REDACTED, webhook: { secret: REDACTED } } },
      launch: { maxConcurrent: 6 },
    });
  });
});

describe("zip writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("writes an archive unzip can list, test and extract", () => {
    const dir = tempDir();
    const zipPath = path.join(dir, "out.zip");
    const big = "harbor ".repeat(10_000); // compressible: deflated
    const random = Buffer.from(
      Array.from({ length: 512 }, (_, i) => (i * 7919) % 251),
    ); // short, stored
    writeFileSync(
      zipPath,
      createZip([
        { name: "a.txt", data: "hello" },
        { name: "nested/big.txt", data: big },
        { name: "bin.dat", data: random },
        { name: "empty.txt", data: "" },
      ]),
    );
    execFileSync("unzip", ["-tq", zipPath]);
    expect(unzipList(zipPath)).toEqual([
      "a.txt",
      "nested/big.txt",
      "bin.dat",
      "empty.txt",
    ]);
    expect(unzipRead(zipPath, "a.txt")).toBe("hello");
    expect(unzipRead(zipPath, "nested/big.txt")).toBe(big);
  });
});

describe("buildDiagnosticsZip", () => {
  it("bundles logs, the redacted config, versions and the rules list", () => {
    const dir = tempDir();
    const logsDir = path.join(dir, "logs");
    mkdirSync(path.join(logsDir, "old"), { recursive: true });
    writeFileSync(path.join(logsDir, "wake.log"), "power: resume\n");
    writeFileSync(path.join(logsDir, "old", "wake.log.1"), "older\n");
    const configFile = path.join(dir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ automation: true, token: "s3cret" }),
    );
    const zipPath = path.join(dir, diagnosticsFileName(new Date(0)));
    writeFileSync(
      zipPath,
      buildDiagnosticsZip({
        logsDir,
        configFile,
        versions: { app: "1.2.3", electron: "33.3.1", node: "20.18.1" },
        rulesList: "review-changes-requested\n",
        now: new Date(0),
      }),
    );

    expect(path.basename(zipPath)).toBe(
      "harbormaster-diagnostics-1970-01-01-00-00-00.zip",
    );
    expect(unzipList(zipPath).sort()).toEqual([
      "config.redacted.json",
      "logs/old/wake.log.1",
      "logs/wake.log",
      "rules-list.txt",
      "versions.json",
    ]);
    expect(JSON.parse(unzipRead(zipPath, "config.redacted.json"))).toEqual({
      automation: true,
      token: REDACTED,
    });
    expect(JSON.parse(unzipRead(zipPath, "versions.json"))).toMatchObject({
      app: "1.2.3",
      electron: "33.3.1",
      node: "20.18.1",
      exportedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(unzipRead(zipPath, "logs/wake.log")).toBe("power: resume\n");
  });

  it("describes a missing config and logs dir instead of failing", () => {
    const dir = tempDir();
    const zipPath = path.join(dir, "d.zip");
    writeFileSync(
      zipPath,
      buildDiagnosticsZip({
        logsDir: path.join(dir, "nope"),
        configFile: path.join(dir, "missing.json"),
        versions: {},
      }),
    );
    expect(unzipList(zipPath).sort()).toEqual([
      "config.redacted.json",
      "versions.json",
    ]);
    expect(unzipRead(zipPath, "config.redacted.json")).toMatch(
      /does not exist/,
    );
  });

  it("keeps only the newest bytes of an oversized log", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "big.log"), "old-old-new!");
    const [entry] = collectLogEntries(dir, 4);
    expect(entry.name).toBe("logs/big.log");
    expect(entry.data.toString()).toBe("new!");
  });
});
