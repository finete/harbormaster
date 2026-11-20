// The composer's `/` menu, core side (docs/new-task-composer.md "Slash
// commands"): frontmatter parsing, each harness's skill / command readers
// over real temp directories (Claude's plugin listing through a fake
// `claude` on HARBORMASTER_CLAUDE_COMMAND, shaped like contract row
// claude.plugin.list-json), and which leading token a long
// launch prompt keeps inline.

import { chmodSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ancestorAgentsSkillDirs,
  ClaudeSlashCommandAccess,
  CodexSlashCommandAccess,
  PiSlashCommandAccess,
} from "../src/access/local-slash-command-access.js";
import { leadingCommand } from "../src/harness/adapter-common.js";
import {
  firstLine,
  frontmatterString,
  parseFrontmatter,
} from "../src/utilities/frontmatter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harbormaster-slash-")),
  );
  roots.push(root);
  return root;
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function skill(
  name: string | undefined,
  description?: string,
  extra = "",
): string {
  return [
    "---",
    ...(name ? [`name: ${name}`] : []),
    ...(description ? [`description: ${description}`] : []),
    extra,
    "---",
    "",
    "# Instructions",
    "Do the thing.",
    "",
  ].join("\n");
}

describe("frontmatter", () => {
  it("splits the YAML block from the body, folding multi-line values", () => {
    const { data, body } = parseFrontmatter(
      '---\nname: pdf\ndescription: >-\n  Extract text\n  from PDFs.\nargument-hint: "[file]"\n---\n# PDF\nBody\n',
    );
    expect(frontmatterString(data, "name")).toBe("pdf");
    expect(frontmatterString(data, "description")).toBe(
      "Extract text from PDFs.",
    );
    expect(frontmatterString(data, "argument-hint")).toBe("[file]");
    expect(body).toBe("# PDF\nBody\n");
    expect(firstLine(body)).toBe("PDF");
  });

  it("is tolerant: no block, invalid YAML, or a non-map block", () => {
    expect(parseFrontmatter("Just text")).toEqual({
      data: {},
      body: "Just text",
    });
    expect(parseFrontmatter("---\nname: [oops\n---\nBody").data).toEqual({});
    expect(parseFrontmatter("---\n- a\n---\nBody")).toEqual({
      data: {},
      body: "Body",
    });
    expect(firstLine("\n\n  \n## Heading\nmore")).toBe("Heading");
  });
});

describe("Claude Code", () => {
  /** A fake `claude` answering `plugin list --json` with `rows`, recording its cwd. */
  async function fakeClaude(root: string, rows: unknown): Promise<string> {
    const bin = join(root, "bin", "claude");
    await put(join(root, "bin", "plugins.json"), JSON.stringify(rows));
    await put(
      bin,
      [
        "#!/bin/sh",
        'dir="$(dirname "$0")"',
        'pwd -P > "$dir/cwd.txt"',
        '[ "$1 $2 $3" = "plugin list --json" ] && cat "$dir/plugins.json"',
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("lists project, user and enabled plugins' skills and commands under Claude's names", async () => {
    const root = await tempRoot();
    const config = join(root, "claude");
    const project = join(root, "repo");
    // User: a skill (frontmatter name wins over the folder), a hidden
    // skill, a nested command (the folder only groups it).
    await put(
      join(config, "skills", "folder-name", "SKILL.md"),
      skill("pr-review", "Review a PR", 'argument-hint: "<url>"'),
    );
    await put(
      join(config, "skills", "background", "SKILL.md"),
      skill("background", "Model-only", "user-invocable: false"),
    );
    // Claude reads skills one level deep only.
    await put(
      join(config, "skills", "group", "nested", "SKILL.md"),
      skill("nested", "Too deep for Claude"),
    );
    await put(
      join(config, "commands", "frontend", "component.md"),
      "Create a component named $ARGUMENTS\n",
    );
    // Project: shadows the user's same-named skill.
    await put(
      join(project, ".claude", "skills", "pr-review", "SKILL.md"),
      skill(undefined, "The repo's own review"),
    );
    await put(
      join(project, ".claude", "commands", "deploy.md"),
      "---\ndescription: Ship it\n---\nDeploy.\n",
    );
    // Plugins: the manifest's name prefixes; a disabled one is skipped; a
    // Gemini-style .toml command is not Claude's.
    const enabled = join(root, "plugins", "build");
    await put(
      join(enabled, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "@acme/build", commands: "./extra/lint.md" }),
    );
    await put(
      join(enabled, "skills", "check", "SKILL.md"),
      skill("check", "Run every check"),
    );
    await put(join(enabled, "commands", "ci", "status.md"), "CI status\n");
    await put(join(enabled, "commands", "legacy.toml"), "prompt = 'x'\n");
    await put(join(enabled, "extra", "lint.md"), "Lint everything\n");
    const disabled = join(root, "plugins", "off");
    await put(
      join(disabled, "skills", "nope", "SKILL.md"),
      skill("nope", "Never listed"),
    );
    const noManifest = join(root, "plugins", "bare");
    await put(join(noManifest, "commands", "hello.md"), "Say hello\n");
    const claude = await fakeClaude(root, [
      { id: "build@acme", enabled: true, installPath: enabled },
      { id: "off@acme", enabled: false, installPath: disabled },
      {
        id: "bare@market",
        enabled: false,
        projectEnabled: true,
        installPath: noManifest,
      },
    ]);

    const access = new ClaudeSlashCommandAccess({
      configDir: config,
      env: { HARBORMASTER_CLAUDE_COMMAND: claude },
    });
    const list = await access.listSlashCommands(project);
    expect(list).toEqual([
      {
        command: "/pr-review",
        kind: "skill",
        source: "project",
        description: "The repo's own review",
      },
      {
        command: "/deploy",
        kind: "command",
        source: "project",
        description: "Ship it",
      },
      {
        command: "/component",
        kind: "command",
        source: "user",
        description: "Create a component named $ARGUMENTS",
      },
      {
        command: "/@acme/build:check",
        kind: "skill",
        source: "plugin",
        plugin: "@acme/build",
        description: "Run every check",
      },
      {
        command: "/@acme/build:ci:status",
        kind: "command",
        source: "plugin",
        plugin: "@acme/build",
        description: "CI status",
      },
      {
        command: "/@acme/build:lint",
        kind: "command",
        source: "plugin",
        plugin: "@acme/build",
        description: "Lint everything",
      },
      {
        command: "/bare:hello",
        kind: "command",
        source: "plugin",
        plugin: "bare",
        description: "Say hello",
      },
    ]);
    // The plugin listing ran in the workspace (project-enabled plugins).
    expect((await readFile(join(root, "bin", "cwd.txt"), "utf8")).trim()).toBe(
      project,
    );

    // Without a workspace: the user's own (the shadowed skill reappears).
    const userOnly = await access.listSlashCommands();
    expect(userOnly.map((entry) => entry.command)).toContain("/pr-review");
    expect(userOnly.find((e) => e.command === "/pr-review")).toMatchObject({
      source: "user",
      description: "Review a PR",
      argumentHint: "<url>",
    });
    expect(userOnly.some((entry) => entry.source === "project")).toBe(false);
  });

  it("a missing or failing claude only drops the plugins", async () => {
    const root = await tempRoot();
    const config = join(root, "claude");
    await put(
      join(config, "skills", "mine", "SKILL.md"),
      skill("mine", "Mine"),
    );
    for (const command of [join(root, "missing-claude"), "/usr/bin/false"]) {
      const access = new ClaudeSlashCommandAccess({
        configDir: config,
        env: { HARBORMASTER_CLAUDE_COMMAND: command },
      });
      expect(
        (await access.listSlashCommands()).map((entry) => entry.command),
      ).toEqual(["/mine"]);
    }
  });
});

describe("Pi", () => {
  it("lists prompt templates as /name and skills as /skill:name, from Pi's own and the Agent Skills locations", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const agentDir = join(root, "pi-agent");
    const repo = join(root, "repo");
    const cwd = join(repo, "packages", "web");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });

    await put(
      join(agentDir, "prompts", "review.md"),
      '---\ndescription: Review staged changes\nargument-hint: "[focus]"\n---\nReview.\n',
    );
    // Only direct children of prompts/ are templates.
    await put(join(agentDir, "prompts", "nested", "deep.md"), "Deep\n");
    // Skills nest in folders; one without a description is not loaded.
    await put(
      join(agentDir, "skills", "docs", "pdf-tools", "SKILL.md"),
      skill("pdf-tools", "Extract PDFs"),
    );
    await put(
      join(agentDir, "skills", "undescribed", "SKILL.md"),
      skill("undescribed"),
    );
    await put(
      join(home, ".agents", "skills", "shared", "SKILL.md"),
      skill(undefined, "From ~/.agents"),
    );
    await put(join(cwd, ".pi", "prompts", "ship.md"), "Ship the web package\n");
    await put(
      join(cwd, ".pi", "skills", "web", "SKILL.md"),
      skill("web", "Web package skill"),
    );
    // `.agents/skills` from the cwd up to the git root, not above it.
    await put(
      join(repo, ".agents", "skills", "repo-wide", "SKILL.md"),
      skill("repo-wide", "Repo-wide skill"),
    );
    await put(
      join(root, ".agents", "skills", "outside", "SKILL.md"),
      skill("outside", "Above the git root"),
    );

    const access = new PiSlashCommandAccess({ agentDir, home, env: {} });
    const list = await access.listSlashCommands(cwd);
    expect(list.map((entry) => [entry.command, entry.source])).toEqual([
      ["/review", "user"],
      ["/ship", "project"],
      ["/skill:pdf-tools", "user"],
      ["/skill:shared", "user"],
      ["/skill:web", "project"],
      ["/skill:repo-wide", "project"],
    ]);
    expect(list[0]).toMatchObject({
      kind: "command",
      description: "Review staged changes",
      argumentHint: "[focus]",
    });
    expect(list[1]).toMatchObject({ description: "Ship the web package" });

    // $PI_CODING_AGENT_DIR is Pi's agent dir when none is configured.
    const fromEnv = new PiSlashCommandAccess({
      home,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    expect(
      (await fromEnv.listSlashCommands()).map((entry) => entry.command),
    ).toEqual(["/review", "/skill:pdf-tools", "/skill:shared"]);
  });

  it("walks .agents/skills up to the git root, or to / without one", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    expect(ancestorAgentsSkillDirs(join(root, "repo", "a"))).toEqual([
      join(root, "repo", "a", ".agents", "skills"),
      join(root, "repo", ".agents", "skills"),
    ]);
    const loose = ancestorAgentsSkillDirs(join(root, "loose"));
    expect(loose[0]).toBe(join(root, "loose", ".agents", "skills"));
    expect(loose.at(-1)).toBe(join("/", ".agents", "skills"));
  });
});

describe("Codex", () => {
  it("lists skills as $name: the repository's, $CODEX_HOME's, ~/.agents' and the bundled .system ones", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const codexHome = join(root, "codex");
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await put(
      join(codexHome, "skills", "mine", "SKILL.md"),
      skill("mine", "Mine"),
    );
    await put(
      join(codexHome, "skills", ".system", "skill-creator", "SKILL.md"),
      skill("skill-creator", "Create a skill"),
    );
    await put(
      join(home, ".agents", "skills", "plannotator-review", "SKILL.md"),
      skill("plannotator-review", "Review"),
    );
    await put(
      join(repo, ".agents", "skills", "repo", "SKILL.md"),
      skill("repo", "The repo's"),
    );
    const access = new CodexSlashCommandAccess({ codexHome, home, env: {} });
    expect(
      (await access.listSlashCommands(repo)).map((entry) => [
        entry.command,
        entry.source,
      ]),
    ).toEqual([
      ["$repo", "project"],
      ["$mine", "user"],
      ["$plannotator-review", "user"],
      ["$skill-creator", "user"],
    ]);
  });
});

describe("leadingCommand", () => {
  it("recognizes the commands the menu inserts, not paths or shell variables", () => {
    for (const command of [
      "/review",
      "/caveman:caveman",
      "/@fordefi/build:check",
      "/skill:pdf-tools",
      "/commit-commands:commit-push-pr",
      "$plannotator-review",
    ]) {
      expect(leadingCommand(`${command} then more`)).toBe(command);
      expect(leadingCommand(command)).toBe(command);
    }
    for (const prompt of [
      "/Users/me/shot.png is broken",
      "$HOME is wrong",
      "Fix /review",
      " /review",
      "/",
      `/${"x".repeat(130)} long`,
    ]) {
      expect(leadingCommand(prompt)).toBeUndefined();
    }
  });
});
