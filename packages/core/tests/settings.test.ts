// Settings foundation (docs/settings.md S4/S6/S8/S12): the description's
// validation engine, the generic key-path writes in JsonConfigAccess, the
// config.json watcher (hand edits, invalid files, own-write dedupe) and the
// manager's change reactions for UI writes and hand edits alike.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalGitRepositoryAccess } from "../src/access/git-repository-access.js";
import { JsonConfigAccess } from "../src/access/json-config-access.js";
import type { ConfigChangedPayload } from "../src/contracts/events.js";
import type { OnboardingProbeAccess } from "../src/contracts/onboarding.js";
import type { ConfigChange } from "../src/contracts/services.js";
import { SETTINGS_DESCRIPTION } from "../src/contracts/settings.js";
import {
  affectsConfiguration,
  changedConfigKeys,
  explicitSettingKeys,
  settingsValues,
  sourceSettingKey,
  validateSettingsPatch,
} from "../src/engines/settings.js";
import { githubSource } from "../src/engines/sources/github-source.js";
import { type Core, createCore } from "../src/index.js";

const context = { harnessIds: ["pi", "claude-code", "aider"] };

/**
 * Write `text` to `path` until `check` passes. macOS FSEvents may miss a
 * change made right after a watcher starts; rewriting the same content is
 * harmless (unchanged text is never reported twice) and keeps these tests
 * free of a startup sleep. `interval` must exceed the watcher's debounce.
 */
async function writeUntil(
  path: string,
  text: string,
  check: () => void,
  interval = 100,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await writeFile(path, text);
      await new Promise((resolve) => setTimeout(resolve, interval));
      check();
    },
    { timeout: 8000, interval: 0 },
  );
}

describe("settings description", () => {
  it("describes every v1 setting once, with a default of its own type", () => {
    const keys = SETTINGS_DESCRIPTION.map((setting) => setting.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "codeRoot",
        "branchPrefix",
        "terminal.fontSize",
        "terminal.screenReader",
        "notifications.enabled",
        "automation",
        "launch.defaultHarness",
        "launch.defaultModel",
        "launch.bypassPermissions",
        "launch.maxConcurrent",
        "launch.maxNestingDepth",
        "captureAgentBrowser",
        "sources.github.enabled",
        "messaging.parentReplyTimeoutMinutes",
        "messaging.loopCap",
        "messaging.directRoutes",
        "inbox.priorityFilter",
      ]),
    );
    for (const setting of SETTINGS_DESCRIPTION) {
      if (setting.default === null) continue;
      const expected =
        setting.type === "integer"
          ? "number"
          : setting.type === "boolean"
            ? "boolean"
            : "string";
      expect(typeof setting.default, setting.key).toBe(expected);
    }
    // Transportable: plain data survives a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(SETTINGS_DESCRIPTION))).toEqual(
      SETTINGS_DESCRIPTION,
    );
  });
});

describe("validateSettingsPatch", () => {
  it("accepts valid values (trimming text) and null resets", () => {
    const result = validateSettingsPatch(
      {
        "terminal.fontSize": 16,
        "notifications.enabled": false,
        "launch.defaultHarness": " aider ",
        "launch.defaultModel": "  sonnet ",
        branchPrefix: "",
        "messaging.loopCap": null,
      },
      context,
    );
    expect(result.problems).toEqual([]);
    expect(result.values).toEqual({
      "terminal.fontSize": 16,
      "notifications.enabled": false,
      "launch.defaultHarness": "aider",
      "launch.defaultModel": "sonnet",
      branchPrefix: "",
      "messaging.loopCap": null,
    });
  });

  it("messaging.directRoutes: defaults to same-task-tree, accepts the three values, rejects others", () => {
    const setting = SETTINGS_DESCRIPTION.find(
      (entry) => entry.key === "messaging.directRoutes",
    );
    expect(setting).toMatchObject({
      type: "enum",
      default: "same-task-tree",
      title: "Messages between tasks",
      values: ["parent-and-child", "same-task-tree", "any-task"],
      valueLabels: {
        "parent-and-child": "Parent and child",
        "same-task-tree": "Same task tree",
        "any-task": "Any task",
      },
    });
    for (const value of ["parent-and-child", "same-task-tree", "any-task"]) {
      expect(
        validateSettingsPatch({ "messaging.directRoutes": value }, context)
          .problems,
      ).toEqual([]);
    }
    expect(
      validateSettingsPatch(
        { "messaging.directRoutes": "everyone" },
        context,
      ).problems.join("\n"),
    ).toMatch(/must be one of: parent-and-child, same-task-tree, any-task/);
  });

  it("rejects unknown keys, wrong types, out-of-range numbers, empty text and unknown agents", () => {
    const result = validateSettingsPatch(
      {
        "nope.key": 1,
        "terminal.fontSize": 7,
        "launch.maxConcurrent": 2.5,
        "notifications.enabled": "yes",
        "launch.defaultModel": "  ",
        "launch.defaultHarness": "codex",
        "messaging.loopCap": 101,
      } as never,
      context,
    );
    expect(result.problems).toHaveLength(7);
    expect(result.problems.join("\n")).toMatch(/Unknown setting "nope.key"/);
    expect(result.problems.join("\n")).toMatch(/at least 8/);
    expect(result.problems.join("\n")).toMatch(/whole number/);
    expect(result.problems.join("\n")).toMatch(/on or off/);
    expect(result.problems.join("\n")).toMatch(/must not be empty/);
    expect(result.problems.join("\n")).toMatch(/Unknown agent "codex"/);
    expect(result.problems.join("\n")).toMatch(/at most 100/);
  });

  it("reads effective values, explicit keys and changed key paths", () => {
    const values = settingsValues({
      automation: false,
      launch: { maxConcurrent: 3 },
    });
    expect(values.automation).toBe(false);
    expect(values["launch.maxConcurrent"]).toBe(3);
    expect(values["terminal.fontSize"]).toBe(13);
    // Screen-reader support is off unless turned on (it can freeze busy panes).
    expect(values["terminal.screenReader"]).toBe(false);
    expect(
      settingsValues({ terminal: { screenReader: true } })[
        "terminal.screenReader"
      ],
    ).toBe(true);
    expect(values["launch.defaultModel"]).toBeNull();
    expect(
      explicitSettingKeys({ launch: { maxConcurrent: 3 }, other: 1 }),
    ).toEqual(["launch.maxConcurrent"]);
    const changed = changedConfigKeys(
      { codeRoot: "/a", launch: { maxConcurrent: 3 }, keep: [1] },
      { codeRoot: "/b", launch: {}, keep: [1], terminal: { fontSize: 14 } },
    );
    expect(changed).toEqual(["codeRoot", "launch.maxConcurrent", "terminal"]);
    expect(affectsConfiguration(changed, "terminal.fontSize")).toBe(true);
    expect(affectsConfiguration(changed, "launch")).toBe(true);
    expect(affectsConfiguration(changed, "automation")).toBe(false);
  });
});

describe("source settings (S10)", () => {
  const pingerSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      threshold: { type: "integer", minimum: 1, title: "Threshold" },
      mode: { type: "string", enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" } },
    },
  };
  const sourceContext = {
    ...context,
    sources: [
      { id: "github", settingsSchema: githubSource.settingsSchema },
      { id: "pinger", settingsSchema: pingerSchema },
      { id: "harbormaster" },
    ],
    sourceSettings: (id: string) =>
      id === "pinger" ? { mode: "fast" } : ({} as Record<string, unknown>),
  };

  it("parses source keys", () => {
    expect(sourceSettingKey("sources.pinger.enabled")).toEqual({
      sourceId: "pinger",
      field: "enabled",
    });
    expect(sourceSettingKey("sources.pinger.settings.threshold")).toEqual({
      sourceId: "pinger",
      field: "settings",
      property: "threshold",
    });
    expect(sourceSettingKey("sources.pinger")).toBeUndefined();
    expect(sourceSettingKey("sources.pinger.settings.a.b")).toBeUndefined();
    expect(sourceSettingKey("launch.maxConcurrent")).toBeUndefined();
  });

  it("accepts on/off and schema-valid properties of registered sources, and null resets", () => {
    const result = validateSettingsPatch(
      {
        "sources.pinger.enabled": false,
        "sources.pinger.settings.threshold": 3,
        "sources.pinger.settings.mode": null,
        "sources.harbormaster.enabled": true,
        "sources.github.settings.searchIntervalMs": 120_000,
      },
      sourceContext,
    );
    expect(result.problems).toEqual([]);
    expect(result.values).toEqual({
      "sources.pinger.enabled": false,
      "sources.pinger.settings.threshold": 3,
      "sources.pinger.settings.mode": null,
      "sources.harbormaster.enabled": true,
      "sources.github.settings.searchIntervalMs": 120_000,
    });
  });

  it("rejects unknown sources / properties, non-scalar values and anything the source's schema refuses", () => {
    const problems = (patch: Record<string, unknown>) =>
      validateSettingsPatch(patch as never, sourceContext).problems.join("\n");
    expect(problems({ "sources.nope.enabled": true })).toMatch(
      /Unknown source "nope"/,
    );
    expect(problems({ "sources.pinger.enabled": "off" })).toMatch(/on or off/);
    expect(problems({ "sources.pinger.settings.other": 1 })).toMatch(
      /has no setting "other"/,
    );
    expect(problems({ "sources.harbormaster.settings.x": 1 })).toMatch(
      /has no setting "x"/,
    );
    expect(problems({ "sources.pinger.settings.tags": ["a"] })).toMatch(
      /config\.json/,
    );
    // The schema's own rules (minimum, enum), with the friendly path.
    expect(problems({ "sources.pinger.settings.threshold": 0 })).toMatch(
      /^sources\.pinger\.settings\.threshold must be >= 1/,
    );
    expect(problems({ "sources.pinger.settings.mode": "medium" })).toMatch(
      /sources\.pinger\.settings\.mode must be equal to one of the allowed values/,
    );
    // A described github key is checked by its description and by the schema.
    expect(
      problems({ "sources.github.settings.watchMentions": "yes" }),
    ).toMatch(/on or off/);
  });

  it("the github settings description matches the defaults the source applies", () => {
    const properties = githubSource.settingsSchema?.properties as Record<
      string,
      { default?: unknown }
    >;
    for (const name of Object.keys(properties)) {
      const setting = SETTINGS_DESCRIPTION.find(
        (entry) => entry.key === `sources.github.settings.${name}`,
      );
      expect(setting?.default, name).toBe(properties[name]?.default);
    }
  });
});

describe("JsonConfigAccess settings writes and watcher", () => {
  let dir: string;
  let path: string;
  const accesses: JsonConfigAccess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harbormaster-settings-test-"));
    path = join(dir, "config.json");
  });

  afterEach(async () => {
    for (const access of accesses.splice(0)) access.stopWatching();
    await rm(dir, { recursive: true, force: true });
  });

  function open(): { access: JsonConfigAccess; changes: ConfigChange[] } {
    const access = new JsonConfigAccess(path, { watchDebounceMs: 20 });
    accesses.push(access);
    const changes: ConfigChange[] = [];
    access.onChange((change) => changes.push(change));
    return { access, changes };
  }

  it("sets and removes key paths, keeping unknown keys and pruning emptied parents", async () => {
    await writeFile(
      path,
      JSON.stringify({
        automation: true,
        futureKey: { nested: [1, 2] },
        launch: { maxConcurrent: 4 },
        sources: { github: { enabled: true, settings: { custom: "x" } } },
      }),
    );
    const { access } = open();
    const config = await access.applySettings({
      set: {
        "terminal.fontSize": 18,
        "notifications.enabled": false,
        "launch.maxConcurrent": null,
        "sources.github.settings.watchMentions": true,
      },
    });
    expect(config.terminal?.fontSize).toBe(18);
    expect(config.notifications?.enabled).toBe(false);
    expect(config.launch).toBeUndefined();
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toEqual({
      automation: true,
      futureKey: { nested: [1, 2] },
      sources: {
        github: {
          enabled: true,
          settings: { custom: "x", watchMentions: true },
        },
      },
      terminal: { fontSize: 18 },
      notifications: { enabled: false },
    });
  });

  it("rejects an out-of-range terminal.fontSize at load and before writing", async () => {
    await writeFile(path, JSON.stringify({ terminal: { fontSize: 99 } }));
    const { access } = open();
    await expect(access.load()).rejects.toThrow(/terminal.fontSize/);
    await writeFile(path, JSON.stringify({}));
    await expect(
      access.applySettings({ set: { "terminal.fontSize": 2 } }),
    ).rejects.toThrow(/terminal.fontSize/);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({});
  });

  it("reports a valid hand edit once, as a file change", async () => {
    await writeFile(path, JSON.stringify({ automation: true }));
    const { access, changes } = open();
    await access.load();
    access.startWatching();
    await writeUntil(path, JSON.stringify({ automation: false }), () =>
      expect(changes).toHaveLength(1),
    );
    expect(changes[0]?.origin).toBe("file");
    expect(changes[0]?.previous.automation).toBe(true);
    expect(changes[0]?.config.automation).toBe(false);
    // A later load of the same content reports nothing new.
    expect((await access.load()).automation).toBe(false);
    expect(changes).toHaveLength(1);
  });

  it("keeps the last good config on an invalid edit, reports the error with its line, and clears it once fixed", async () => {
    await writeFile(path, JSON.stringify({ automation: false }));
    const { access, changes } = open();
    await access.load();
    access.startWatching();
    await writeUntil(path, '{\n  "automation": true,\n  oops\n}\n', () =>
      expect(changes).toHaveLength(1),
    );
    expect(changes[0]?.error?.line).toBe(3);
    expect(changes[0]?.config.automation).toBe(false);
    const broken = await access.snapshot();
    expect(broken.config.automation).toBe(false);
    expect(broken.error?.line).toBe(3);
    expect((await access.load()).automation).toBe(false);

    // A schema problem (valid JSON) is an error too, without a line.
    await writeUntil(path, JSON.stringify({ messaging: { loopCap: -1 } }), () =>
      expect(changes).toHaveLength(2),
    );
    expect(changes[1]?.error?.message).toMatch(/messaging.loopCap/);

    await writeUntil(path, JSON.stringify({ automation: true }), () =>
      expect(changes).toHaveLength(3),
    );
    expect(changes[2]?.error).toBeUndefined();
    expect(changes[2]?.config.automation).toBe(true);
    expect((await access.snapshot()).error).toBeUndefined();
  });

  it("reports core's own write once (origin core), never again through the watcher", async () => {
    await writeFile(path, JSON.stringify({ automation: true }));
    const { access, changes } = open();
    await access.load();
    access.startWatching();
    await access.applySettings({ set: { "terminal.fontSize": 15 } });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.origin).toBe("core");
    // Nothing else may arrive: wait well past the debounce (the absence of
    // an event is the behaviour under test).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes).toHaveLength(1);
    // A write that changes nothing reports nothing.
    await access.applySettings({ set: { "terminal.fontSize": 15 } });
    expect(changes).toHaveLength(1);
  });
});

describe("settings commands and change reactions", () => {
  const roots: string[] = [];
  const cores: Core[] = [];

  afterEach(async () => {
    for (const core of cores.splice(0)) core.close();
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "hbm-settings-"));
    roots.push(root);
    const home = join(root, "home");
    const code = join(root, "code");
    await mkdir(home, { recursive: true });
    await mkdir(code, { recursive: true });
    const stateDir = join(root, "state");
    await mkdir(stateDir, { recursive: true });
    const configPath = join(stateDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        automation: true,
        codeRoot: code,
        repositories: {
          "github.com/acme/web": { defaultHarness: "claude-code" },
          "github.com/acme/api": { bypassPermissions: false },
          "github.com/acme/doc": {
            defaultHarness: "pi",
            bypassPermissions: true,
          },
        },
      }),
    );
    const onboarding = {
      homeDir: () => home,
      isDirectory: async (path: string) =>
        path === home || path.startsWith(root),
    } as unknown as OnboardingProbeAccess;
    const core = createCore({ stateDir, onboarding, watchConfig: true });
    cores.push(core);
    const events: ConfigChangedPayload[] = [];
    core.events.on("config-changed", (payload) => events.push(payload));
    return { root, home, code, configPath, core, events };
  }

  it("reads values, explicit keys and per-repository override counts", async () => {
    const { core, code } = await setup();
    const settings = await core.commands.getSettings();
    expect(settings.values.codeRoot).toBe(code);
    expect(settings.values["terminal.fontSize"]).toBe(13);
    expect(settings.explicit.sort()).toEqual(["automation", "codeRoot"]);
    expect(settings.overriddenIn).toEqual({
      "launch.defaultHarness": 2,
      "launch.bypassPermissions": 2,
    });
    expect(settings.harnesses.map((option) => option.id)).toEqual(
      expect.arrayContaining(["pi", "claude-code"]),
    );
    expect(settings.error).toBeUndefined();
  });

  it("updates settings, emits config-changed, resets with null, and rejects invalid patches without writing", async () => {
    const { core, configPath, events } = await setup();
    const updated = await core.commands.updateSettings({
      "terminal.fontSize": 20,
      "launch.defaultHarness": "claude-code",
    });
    expect(updated.values["terminal.fontSize"]).toBe(20);
    expect(updated.explicit).toContain("terminal.fontSize");
    expect(events.at(-1)).toEqual({
      changedKeys: ["launch", "terminal"],
      origin: "core",
    });

    await expect(
      core.commands.updateSettings({ "terminal.fontSize": 100, foo: 1 }),
    ).rejects.toThrow(/at most 32.*Unknown setting "foo"|Unknown setting/);
    await expect(
      core.commands.updateSettings({ codeRoot: "/definitely/not/here" }),
    ).rejects.toThrow(/is not a folder/);
    await expect(
      core.commands.updateSettings({ branchPrefix: "bad..prefix" }),
    ).rejects.toThrow(/^branchPrefix is not a valid Git branch namespace/);

    const reset = await core.commands.updateSettings({
      "terminal.fontSize": null,
    });
    expect(reset.values["terminal.fontSize"]).toBe(13);
    expect(reset.explicit).not.toContain("terminal.fontSize");
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.terminal).toBeUndefined();
    expect(raw.launch).toEqual({ defaultHarness: "claude-code" });
    expect(raw.repositories["github.com/acme/web"]).toEqual({
      defaultHarness: "claude-code",
    });
  });

  it("existing per-setting commands go through the same change path", async () => {
    const { core, events } = await setup();
    await core.commands.setCaptureAgentBrowser(true);
    await core.commands.setRulesEnabled(false);
    expect(events.map((event) => event.changedKeys)).toEqual([
      ["captureAgentBrowser"],
      ["automation"],
    ]);
  });

  it("a hand edit of codeRoot reaches frontends and triggers repository rediscovery", async () => {
    const discover = vi.spyOn(
      LocalGitRepositoryAccess.prototype,
      "discoverRepositories",
    );
    const { core, root, configPath, events } = await setup();
    await core.commands.getSettings();
    const other = join(root, "elsewhere");
    await mkdir(other);
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    await writeUntil(
      configPath,
      JSON.stringify({ ...raw, codeRoot: other }),
      () => expect(discover).toHaveBeenCalledWith(other, expect.anything()),
      400,
    );
    expect(events).toContainEqual({
      changedKeys: ["codeRoot"],
      origin: "file",
    });
  });

  it("lists sources (built-ins and add-ons) and writes add-on settings checked against the add-on's schema", async () => {
    const { core, root, configPath } = await setup();
    const addonDir = join(root, "state", "addons", "pinger");
    await mkdir(addonDir, { recursive: true });
    await writeFile(
      join(addonDir, "addon.json"),
      JSON.stringify({
        name: "pinger-addon",
        version: "0.1.0",
        description: "Pings things",
        provides: { sources: ["pinger"] },
      }),
    );
    await writeFile(
      join(addonDir, "source.mjs"),
      `export default {
  id: "pinger",
  title: "Pinger",
  settingsSchema: {
    type: "object",
    properties: { threshold: { type: "integer", minimum: 1 } },
  },
  async snapshot() { return []; },
};\n`,
    );
    const settings = await core.commands.getSettings();
    expect(settings.sources.map((source) => source.id)).toEqual([
      "harbormaster",
      "github",
      "version-endpoint",
      "pinger",
    ]);
    expect(settings.sources.find((source) => source.id === "github")).toEqual(
      expect.objectContaining({
        label: "GitHub",
        builtin: true,
        enabled: true,
      }),
    );
    expect(settings.sources.find((source) => source.id === "pinger")).toEqual({
      id: "pinger",
      label: "Pinger",
      builtin: false,
      addon: { name: "pinger-addon", description: "Pings things" },
      enabled: true,
      enabledExplicit: false,
      settingsSchema: expect.objectContaining({ type: "object" }),
      settings: {},
      explicit: [],
      problems: [],
    });

    const updated = await core.commands.updateSettings({
      "sources.pinger.enabled": false,
      "sources.pinger.settings.threshold": 4,
    });
    const pinger = updated.sources.find((source) => source.id === "pinger");
    expect(pinger).toEqual(
      expect.objectContaining({
        enabled: false,
        enabledExplicit: true,
        settings: { threshold: 4 },
        explicit: ["threshold"],
      }),
    );
    await expect(
      core.commands.updateSettings({ "sources.pinger.settings.threshold": 0 }),
    ).rejects.toThrow(/sources\.pinger\.settings\.threshold must be >= 1/);
    await expect(
      core.commands.updateSettings({ "sources.ghost.enabled": true }),
    ).rejects.toThrow(/Unknown source "ghost"/);
    let raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.sources.pinger).toEqual({
      enabled: false,
      settings: { threshold: 4 },
    });

    await core.commands.updateSettings({
      "sources.pinger.settings.threshold": null,
      "sources.pinger.enabled": null,
    });
    raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.sources).toBeUndefined();
  });

  it("an invalid hand edit reaches frontends as an error and getSettings keeps the last good values", async () => {
    const { core, code, configPath, events } = await setup();
    await core.commands.getSettings();
    await writeUntil(
      configPath,
      "{ not json",
      () => expect(events.at(-1)?.error).toBeDefined(),
      400,
    );
    const settings = await core.commands.getSettings();
    expect(settings.error?.message).toBeTruthy();
    expect(settings.values.codeRoot).toBe(code);
  });
});
