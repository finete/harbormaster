import { describe, expect, it } from "vitest";
import {
  type BundleGuardFs,
  type BundleStamp,
  createAppBundleGuard,
  plistVersion,
} from "../src/main/app-bundle-guard";

const EXE = "/Applications/Harbormaster.app/Contents/MacOS/Harbormaster";
const PLIST = "/Applications/Harbormaster.app/Contents/Info.plist";

function plist(version: string): string {
  return `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>Harbormaster</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`;
}

function memoryFs(stamp: BundleStamp | undefined, version: string) {
  const disk = { stamp, plist: plist(version) };
  const fs: BundleGuardFs = {
    stat: (path) => {
      if (path !== EXE || !disk.stamp) throw new Error("ENOENT");
      return disk.stamp;
    },
    readFile: (path) => {
      if (path !== PLIST) throw new Error("ENOENT");
      return disk.plist;
    },
  };
  return { fs, disk };
}

const STAMP: BundleStamp = { ino: 100, size: 50_000, mtimeMs: 1_000 };

describe("createAppBundleGuard", () => {
  it("reports nothing while the launched bundle is still installed", () => {
    const { fs } = memoryFs(STAMP, "0.6.0");
    const guard = createAppBundleGuard({
      executablePath: EXE,
      infoPlistPath: PLIST,
      fs,
    });
    expect(guard.replacement()).toBeUndefined();
  });

  it("reports the installed version once the bundle is swapped", () => {
    const { fs, disk } = memoryFs(STAMP, "0.6.0");
    const guard = createAppBundleGuard({
      executablePath: EXE,
      infoPlistPath: PLIST,
      fs,
    });
    disk.stamp = { ...STAMP, ino: 101 };
    disk.plist = plist("0.7.1");
    expect(guard.replacement()).toEqual({ installedVersion: "0.7.1" });
  });

  it("treats a removed bundle as replaced, version unknown", () => {
    const { fs, disk } = memoryFs(STAMP, "0.6.0");
    const guard = createAppBundleGuard({
      executablePath: EXE,
      infoPlistPath: PLIST,
      fs,
    });
    disk.stamp = undefined;
    disk.plist = "";
    expect(guard.replacement()).toEqual({ installedVersion: undefined });
  });

  it("stays silent when the executable could not be read at launch", () => {
    const { fs, disk } = memoryFs(undefined, "0.6.0");
    const guard = createAppBundleGuard({ executablePath: EXE, fs });
    disk.stamp = STAMP;
    expect(guard.replacement()).toBeUndefined();
  });
});

describe("plistVersion", () => {
  it("reads CFBundleShortVersionString and nothing else", () => {
    expect(plistVersion(plist("0.7.1"))).toBe("0.7.1");
    expect(
      plistVersion("<key>CFBundleVersion</key><string>9</string>"),
    ).toBeUndefined();
  });
});
