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
    expect(config.movers).toEqual([]);
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
});
