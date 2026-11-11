import { describe, expect, it } from "vitest";
import { resolveCliPath } from "../src/main/cli-path";

function fakeFs(files: Record<string, string>) {
  return {
    exists: (path: string) => path in files,
    readText: (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
  };
}

describe("resolveCliPath", () => {
  const resourcesPath = "/Applications/Harbormaster.app/Contents/Resources";

  it("uses the bundled wrapper in a packaged app", () => {
    const fs = fakeFs({ [`${resourcesPath}/bin/harbormaster`]: "#!/bin/sh" });
    expect(
      resolveCliPath({
        isPackaged: true,
        resourcesPath,
        appPath: `${resourcesPath}/app.asar`,
        ...fs,
      }),
    ).toBe(`${resourcesPath}/bin/harbormaster`);
  });

  it("returns undefined when a packaged app has no CLI bundled", () => {
    expect(
      resolveCliPath({
        isPackaged: true,
        resourcesPath,
        appPath: `${resourcesPath}/app.asar`,
        ...fakeFs({}),
      }),
    ).toBeUndefined();
  });

  it("prefers the workspace bin link in dev, then the cli package's bin entry", () => {
    const pkg = JSON.stringify({ bin: { harbormaster: "dist/cli.js" } });
    const base = {
      "/repo/packages/cli/package.json": pkg,
      "/repo/packages/cli/dist/cli.js": "",
    };
    const context = {
      isPackaged: false,
      resourcesPath: "/electron/Resources",
      appPath: "/repo/packages/app",
    };
    expect(
      resolveCliPath({
        ...context,
        ...fakeFs({ ...base, "/repo/node_modules/.bin/harbormaster": "" }),
      }),
    ).toBe("/repo/node_modules/.bin/harbormaster");
    expect(resolveCliPath({ ...context, ...fakeFs(base) })).toBe(
      "/repo/packages/cli/dist/cli.js",
    );
  });

  it("tolerates a dev checkout without the cli package or its build", () => {
    const context = {
      isPackaged: false,
      resourcesPath: "/electron/Resources",
      appPath: "/repo/packages/app",
    };
    expect(resolveCliPath({ ...context, ...fakeFs({}) })).toBeUndefined();
    expect(
      resolveCliPath({
        ...context,
        ...fakeFs({
          "/repo/packages/cli/package.json": JSON.stringify({
            bin: { harbormaster: "dist/cli.js" },
          }),
        }),
      }),
    ).toBeUndefined();
  });

  it("honors an existing override", () => {
    expect(
      resolveCliPath({
        isPackaged: true,
        resourcesPath,
        appPath: "/x",
        override: "/opt/hm",
        ...fakeFs({ "/opt/hm": "" }),
      }),
    ).toBe("/opt/hm");
  });
});
