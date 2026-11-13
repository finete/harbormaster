import { describe, expect, it } from "vitest";
import {
  type AvailabilityProbes,
  availableOpenInApps,
  buildOpenInArgv,
  getOpenInApp,
  OPEN_IN_APPS,
  type OpenInApp,
} from "../src/main/open-in";
import {
  defaultOpenInApp,
  groupOpenInApps,
  OPEN_IN_LAST_APP_KEY,
  readLastOpenInAppId,
  writeLastOpenInAppId,
} from "../src/renderer/src/lib/open-in";

function app(id: string): OpenInApp {
  const found = getOpenInApp(id);
  if (!found) throw new Error(`no catalog app ${id}`);
  return found;
}

const DIR = "/Users/dev/Code/.harbormaster-worktrees/fix-thing-abc123";

describe("open-in catalog", () => {
  it("has the v1 apps, unique ids, in file manager / editors / terminals order", () => {
    expect(OPEN_IN_APPS.map((entry) => entry.id)).toEqual([
      "finder",
      "vscode",
      "cursor",
      "zed",
      "zed-preview",
      "sublime-text",
      "xcode",
      "android-studio",
      "terminal",
      "iterm2",
      "ghostty",
      "warp",
      "kitty",
      "alacritty",
    ]);
    const kinds = OPEN_IN_APPS.map((entry) => entry.kind);
    expect(kinds.lastIndexOf("file-manager")).toBeLessThan(
      kinds.indexOf("editor"),
    );
    expect(kinds.lastIndexOf("editor")).toBeLessThan(kinds.indexOf("terminal"));
  });

  it("refuses unknown or non-string ids (no default-handler fallback)", () => {
    expect(getOpenInApp("rm -rf")).toBeUndefined();
    expect(getOpenInApp("")).toBeUndefined();
    expect(getOpenInApp(42)).toBeUndefined();
    expect(getOpenInApp(undefined)).toBeUndefined();
  });
});

describe("availableOpenInApps", () => {
  const home = "/Users/dev";

  function macProbes(existing: string[]): AvailabilityProbes {
    const set = new Set(existing);
    return {
      platform: "mac",
      homeDir: home,
      exists: (path) => set.has(path),
      which: () => {
        throw new Error("mac availability must not probe PATH");
      },
    };
  }

  it("macOS: an app is available when its bundle exists in any standard folder", () => {
    const apps = availableOpenInApps(
      macProbes([
        "/System/Library/CoreServices/Finder.app",
        "/Applications/Cursor.app",
        `${home}/Applications/Zed.app`,
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/iTerm.app",
      ]),
    );
    expect(apps).toEqual([
      { id: "finder", label: "Finder", kind: "file-manager" },
      { id: "cursor", label: "Cursor", kind: "editor" },
      { id: "zed", label: "Zed", kind: "editor" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
      { id: "iterm2", label: "iTerm2", kind: "terminal" },
    ]);
  });

  it("macOS: a CLI on PATH alone does not make an app available", () => {
    expect(availableOpenInApps(macProbes([]))).toEqual([]);
  });

  it("linux: availability is the binary on PATH; mac-only apps never show", () => {
    const apps = availableOpenInApps({
      platform: "linux",
      homeDir: home,
      exists: () => true,
      which: (bin) => ["code", "xdg-open", "kitty"].includes(bin),
    });
    expect(apps.map((entry) => entry.id)).toEqual([
      "finder",
      "vscode",
      "kitty",
    ]);
  });

  it("windows: nothing is available yet", () => {
    expect(
      availableOpenInApps({
        platform: "win",
        homeDir: home,
        exists: () => true,
        which: () => true,
      }),
    ).toEqual([]);
  });
});

describe("buildOpenInArgv", () => {
  it("macOS editors open the folder as a project via open -a", () => {
    expect(buildOpenInArgv(app("cursor"), DIR, "mac")).toEqual({
      ok: true,
      command: "open",
      args: ["-a", "Cursor", DIR],
    });
    expect(buildOpenInArgv(app("vscode"), DIR, "mac")).toEqual({
      ok: true,
      command: "open",
      args: ["-a", "Visual Studio Code", DIR],
    });
  });

  it("macOS Finder opens the folder via open -a Finder (never bare open)", () => {
    expect(buildOpenInArgv(app("finder"), DIR, "mac")).toEqual({
      ok: true,
      command: "open",
      args: ["-a", "Finder", DIR],
    });
  });

  it("macOS terminals get the folder; Kitty/Alacritty via a new instance's cwd flag", () => {
    expect(buildOpenInArgv(app("iterm2"), DIR, "mac")).toEqual({
      ok: true,
      command: "open",
      args: ["-a", "iTerm", DIR],
    });
    expect(buildOpenInArgv(app("kitty"), DIR, "mac")).toEqual({
      ok: true,
      command: "open",
      args: ["-n", "-a", "kitty", "--args", "--directory", DIR],
    });
    expect(buildOpenInArgv(app("alacritty"), DIR, "mac")).toEqual({
      ok: true,
      command: "open",
      args: ["-n", "-a", "Alacritty", "--args", "--working-directory", DIR],
    });
  });

  it("keeps a path with spaces or shell metacharacters as one argv element", () => {
    const nasty = "/Users/dev/Code/a b; rm -rf ~ $(x)";
    const argv = buildOpenInArgv(app("zed"), nasty, "mac");
    expect(argv.ok && argv.args.at(-1)).toBe(nasty);
  });

  it("linux: <bin> <dir>, with flag forms", () => {
    expect(buildOpenInArgv(app("vscode"), DIR, "linux")).toEqual({
      ok: true,
      command: "code",
      args: [DIR],
    });
    expect(buildOpenInArgv(app("ghostty"), DIR, "linux")).toEqual({
      ok: true,
      command: "ghostty",
      args: [`--working-directory=${DIR}`],
    });
    expect(buildOpenInArgv(app("kitty"), DIR, "linux")).toEqual({
      ok: true,
      command: "kitty",
      args: ["--directory", DIR],
    });
  });

  it("refuses an app with no launch for the platform", () => {
    expect(buildOpenInArgv(app("xcode"), DIR, "linux").ok).toBe(false);
    expect(buildOpenInArgv(app("cursor"), DIR, "win").ok).toBe(false);
  });
});

describe("renderer open-in helpers", () => {
  const apps = [
    { id: "finder", label: "Finder", kind: "file-manager" as const },
    { id: "cursor", label: "Cursor", kind: "editor" as const },
    { id: "ghostty", label: "Ghostty", kind: "terminal" as const },
  ];

  it("defaults to the last-used app, else an editor, else the file manager, else the first", () => {
    expect(defaultOpenInApp(apps, "ghostty")?.id).toBe("ghostty");
    expect(defaultOpenInApp(apps, "finder")?.id).toBe("finder");
    expect(defaultOpenInApp(apps, "uninstalled")?.id).toBe("cursor");
    expect(defaultOpenInApp(apps, undefined)?.id).toBe("cursor");
    const noEditor = [apps[0], apps[2]];
    expect(defaultOpenInApp(noEditor, undefined)?.id).toBe("finder");
    expect(defaultOpenInApp([apps[2]], undefined)?.id).toBe("ghostty");
    expect(defaultOpenInApp([], "cursor")).toBeUndefined();
  });

  it("groups by kind in fixed order, dropping empty groups", () => {
    expect(
      groupOpenInApps([apps[2], apps[1]]).map((group) => [
        group.label,
        group.apps.map((entry) => entry.id),
      ]),
    ).toEqual([
      ["Editors", ["cursor"]],
      ["Terminals", ["ghostty"]],
    ]);
  });

  it("persists the last app under harbormaster.openIn.lastApp", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    };
    expect(readLastOpenInAppId(storage)).toBeUndefined();
    writeLastOpenInAppId(storage, "zed");
    expect(map.get(OPEN_IN_LAST_APP_KEY)).toBe("zed");
    expect(OPEN_IN_LAST_APP_KEY).toBe("harbormaster.openIn.lastApp");
    expect(readLastOpenInAppId(storage)).toBe("zed");
  });
});
