// Where the app finds the `harbormaster` CLI and how it installs the Pi
// inbox extension (decision R13): only when missing or older, atomically.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installPiExtension,
  PI_EXTENSION_FILE,
  piExtensionsDir,
  readExtensionVersion,
  resolvePiExtensionSource,
} from "../src/main/agent-tooling";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hm-tooling-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length)
    rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const source = (version: number) =>
  `export const HARBORMASTER_INBOX_EXTENSION_VERSION = ${version};\n`;

describe("installPiExtension", () => {
  it("installs when missing, updates only to a newer version, never downgrades", () => {
    const root = tmp();
    const src = path.join(root, "src.ts");
    const target = path.join(root, "pi", "extensions");
    writeFileSync(src, source(2));
    expect(installPiExtension({ sourcePath: src, targetDir: target })).toBe(
      "installed",
    );
    const installed = path.join(target, PI_EXTENSION_FILE);
    expect(readFileSync(installed, "utf8")).toBe(source(2));
    expect(installPiExtension({ sourcePath: src, targetDir: target })).toBe(
      "current",
    );
    writeFileSync(src, source(3));
    expect(installPiExtension({ sourcePath: src, targetDir: target })).toBe(
      "updated",
    );
    expect(readExtensionVersion(readFileSync(installed, "utf8"))).toBe(3);
    writeFileSync(src, source(1));
    expect(installPiExtension({ sourcePath: src, targetDir: target })).toBe(
      "current",
    );
    expect(readExtensionVersion(readFileSync(installed, "utf8"))).toBe(3);
  });

  it("reports a missing source", () => {
    expect(
      installPiExtension({ sourcePath: undefined, targetDir: tmp() }),
    ).toBe("no-source");
  });

  it("ships a versioned extension in the monorepo", () => {
    const mainDir = path.join(__dirname, "..", "out", "main");
    const bundled = resolvePiExtensionSource({
      env: {},
      isPackaged: false,
      resourcesPath: "",
      mainDir,
    });
    expect(bundled).toBeDefined();
    expect(
      readExtensionVersion(readFileSync(bundled as string, "utf8")),
    ).toBeGreaterThan(0);
  });
});

describe("piExtensionsDir", () => {
  it("honors the test override, then PI_CODING_AGENT_DIR, then ~/.pi/agent", () => {
    expect(piExtensionsDir({ HARBORMASTER_PI_EXTENSIONS_DIR: "/x" })).toBe(
      "/x",
    );
    expect(piExtensionsDir({ PI_CODING_AGENT_DIR: "/a" })).toBe(
      "/a/extensions",
    );
    expect(piExtensionsDir({})).toBe(
      path.join(os.homedir(), ".pi", "agent", "extensions"),
    );
  });
});
