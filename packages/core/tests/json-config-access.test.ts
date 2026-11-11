import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonConfigAccess } from "../src/access/json-config-access.js";

describe("JsonConfigAccess", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harbormaster-config-test-"));
    path = join(dir, "config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a default config with codeRoot=~/Code (expanded) and branchPrefix='' on first load", async () => {
    const access = new JsonConfigAccess(path);
    const config = await access.load();
    expect(config.automation).toBe(true);
    // Board automation lives in rules files now: no `movers` key.
    expect(config).not.toHaveProperty("movers");
    expect(config.codeRoot).toBe(join(homedir(), "Code"));
    expect(config.branchPrefix).toBe("");

    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.codeRoot).toBe(join(homedir(), "Code"));
  });

  it("round-trips a saved config with custom codeRoot and branchPrefix", async () => {
    const access = new JsonConfigAccess(path);
    const config = await access.load();
    await access.save({
      ...config,
      codeRoot: "/tmp/code",
      branchPrefix: "hbm",
    });

    const reopened = new JsonConfigAccess(path);
    const reloaded = await reopened.load();
    expect(reloaded.codeRoot).toBe("/tmp/code");
    expect(reloaded.branchPrefix).toBe("hbm/");
  });

  it("expands a ~/ codeRoot to an absolute path", async () => {
    await writeFile(path, JSON.stringify({ codeRoot: "~/somewhere" }));
    const access = new JsonConfigAccess(path);
    const config = await access.load();
    expect(config.codeRoot).toBe(join(homedir(), "somewhere"));
  });

  it("rejects a relative codeRoot", async () => {
    await writeFile(path, JSON.stringify({ codeRoot: "relative/path" }));
    const access = new JsonConfigAccess(path);
    await expect(access.load()).rejects.toThrow("Invalid Harbormaster config");
  });

  it("rejects an invalid branchPrefix", async () => {
    await writeFile(path, JSON.stringify({ branchPrefix: "../escape" }));
    const access = new JsonConfigAccess(path);
    await expect(access.load()).rejects.toThrow("Invalid Harbormaster config");
  });

  it("round-trips a per-repository deployment pipeline, preserving opaque stage options", async () => {
    await writeFile(
      path,
      JSON.stringify({
        repositories: {
          "github.com/acme/widgets": {
            deployment: {
              releaseBranch: "releases/v{major}.{minor}.0",
              stages: [
                {
                  id: "pre",
                  label: "Preprod",
                  hook: "version-endpoint",
                  options: {
                    url: "https://pre.example/version",
                    hotfixDepth: 25,
                  },
                },
                { id: "prod", label: "Production" },
              ],
            },
          },
        },
      }),
    );
    const access = new JsonConfigAccess(path);
    const config = await access.load();
    expect(config.repositories?.["github.com/acme/widgets"]).toEqual({
      deployment: {
        releaseBranch: "releases/v{major}.{minor}.0",
        stages: [
          {
            id: "pre",
            label: "Preprod",
            hook: "version-endpoint",
            options: { url: "https://pre.example/version", hotfixDepth: 25 },
          },
          { id: "prod", label: "Production" },
        ],
      },
    });
  });

  it("defaults a stage label to its id and leaves manual (hookless) stages alone", async () => {
    await writeFile(
      path,
      JSON.stringify({
        repositories: {
          "github.com/acme/widgets": {
            deployment: { stages: [{ id: "prod" }] },
          },
        },
      }),
    );
    const config = await new JsonConfigAccess(path).load();
    expect(
      config.repositories?.["github.com/acme/widgets"]?.deployment?.stages,
    ).toEqual([{ id: "prod", label: "prod" }]);
  });

  it("preserves unknown keys on a repository entry", async () => {
    await writeFile(
      path,
      JSON.stringify({
        repositories: {
          "github.com/acme/widgets": {
            futureField: "kept",
            deployment: { stages: [{ id: "prod" }] },
          },
        },
      }),
    );
    const config = await new JsonConfigAccess(path).load();
    const repository = config.repositories?.[
      "github.com/acme/widgets"
    ] as unknown as Record<string, unknown> | undefined;
    expect(repository?.futureField).toBe("kept");
  });

  it("ignores the retired movers lists in the live config but reports them for the rules migration", async () => {
    await writeFile(path, JSON.stringify({ codeRoot: "/tmp/code" }));
    expect(await new JsonConfigAccess(path).legacyMoverOrders()).toEqual({
      repositories: {},
    });

    await writeFile(
      path,
      JSON.stringify({
        movers: [],
        repositories: { "github.com/acme/x": { movers: ["github-review"] } },
      }),
    );
    const access = new JsonConfigAccess(path);
    const config = await access.load();
    expect(config).not.toHaveProperty("movers");
    expect(config.repositories?.["github.com/acme/x"]).not.toHaveProperty(
      "movers",
    );
    expect(await access.legacyMoverOrders()).toEqual({
      global: [],
      repositories: { "github.com/acme/x": ["github-review"] },
    });
  });

  it("parses per-source settings and rejects malformed ones", async () => {
    await writeFile(
      path,
      JSON.stringify({
        sources: {
          github: { settings: { watchReviewRequests: true } },
          "version-endpoint": { enabled: false },
        },
      }),
    );
    expect((await new JsonConfigAccess(path).load()).sources).toEqual({
      github: { settings: { watchReviewRequests: true } },
      "version-endpoint": { enabled: false },
    });
    await writeFile(
      path,
      JSON.stringify({ sources: { github: { enabled: 1 } } }),
    );
    await expect(new JsonConfigAccess(path).load()).rejects.toThrow(
      "sources.github.enabled",
    );
  });

  it("rejects stage options without a hook at load", async () => {
    await writeFile(
      path,
      JSON.stringify({
        repositories: {
          "github.com/acme/x": {
            deployment: {
              stages: [{ id: "prod", options: { url: "https://x" } }],
            },
          },
        },
      }),
    );
    await expect(new JsonConfigAccess(path).load()).rejects.toThrow(
      "options requires a hook",
    );
  });

  it("rejects an empty stages array and duplicate stage ids", async () => {
    await writeFile(
      path,
      JSON.stringify({
        repositories: { "github.com/acme/x": { deployment: { stages: [] } } },
      }),
    );
    await expect(new JsonConfigAccess(path).load()).rejects.toThrow(
      "Invalid Harbormaster config",
    );

    await writeFile(
      path,
      JSON.stringify({
        repositories: {
          "github.com/acme/x": {
            deployment: { stages: [{ id: "a" }, { id: "a" }] },
          },
        },
      }),
    );
    await expect(new JsonConfigAccess(path).load()).rejects.toThrow(
      "Invalid Harbormaster config",
    );
  });

  it("round-trips a valid launch config and rejects an invalid one", async () => {
    await writeFile(
      path,
      JSON.stringify({
        launch: { maxConcurrent: 3, defaultModel: "openai/gpt" },
      }),
    );
    const config = await new JsonConfigAccess(path).load();
    expect(config.launch).toEqual({
      maxConcurrent: 3,
      defaultModel: "openai/gpt",
    });

    await writeFile(path, JSON.stringify({ launch: { maxConcurrent: 0 } }));
    await expect(new JsonConfigAccess(path).load()).rejects.toThrow(
      "maxConcurrent",
    );

    await writeFile(path, JSON.stringify({ launch: { maxConcurrent: 1.5 } }));
    await expect(new JsonConfigAccess(path).load()).rejects.toThrow(
      "maxConcurrent",
    );

    await writeFile(path, JSON.stringify({ launch: { defaultModel: "" } }));
    await expect(new JsonConfigAccess(path).load()).rejects.toThrow(
      "defaultModel",
    );
  });
});
