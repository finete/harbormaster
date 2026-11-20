// Resource Access behind the composer's `/` menu (docs/new-task-composer.md
// "Slash commands"): each harness's own skill and command files, read-only.
// Where each agent looks, and how a prompt names what it finds:
//
// - Claude Code (2.1.329; docs "Skills" / "Slash commands" / "Plugins"):
//   `<configDir>/skills/<name>/SKILL.md` and `<configDir>/commands/**/*.md`
//   (user), the same under `<cwd>/.claude/` (project), both as `/<name>` (a
//   command's subdirectory only groups it, the name is the file's). Enabled
//   plugins (`claude plugin list --json`, run in `cwd` so project-enabled
//   ones count) add `<installPath>/skills/*/SKILL.md` and
//   `<installPath>/commands/**/*.md` (plus any `skills` / `commands` paths
//   their `.claude-plugin/plugin.json` names) as `/<plugin name>:<name>`.
//   `user-invocable: false` skills stay out of the menu, as in Claude's.
// - Pi (1.5.2; docs/skills.md, docs/prompt-templates.md, checked against
//   `core/skills.js` and `core/package-manager.js`): skills under
//   `<agentDir>/skills`, `<cwd>/.pi/skills`, `~/.agents/skills` and every
//   `.agents/skills` from `cwd` up to its git root, as `/skill:<name>`
//   (only skills with a description load); prompt templates are the direct
//   `.md` children of `<agentDir>/prompts` and `<cwd>/.pi/prompts`, as
//   `/<file name>`. Skills and templates from Pi packages or settings paths
//   are not listed.
// - Codex (0.169.0; the same roots `local-review-support-probe-access.ts`
//   reads, plus the bundled `.system` skills and the repository's
//   `.agents/skills` from `cwd` up to its git root): skills, named in a
//   prompt as `$<name>` (Codex has no `/` form for them).
//
// A skill is a directory holding `SKILL.md` (its subdirectories are its own
// files, never walked); other directories are walked a few levels deep for
// Pi and Codex (Claude reads only `skills/<name>/SKILL.md`), dot
// directories and `node_modules` skipped, symlinks followed.

import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type {
  HarnessSlashCommandAccess,
  SlashCommand,
} from "../contracts/harness.js";
import {
  firstLine,
  frontmatterString,
  parseFrontmatter,
} from "../utilities/frontmatter.js";
import { runOutcome } from "../utilities/run.js";
import { claudeConfigDir } from "./claude-code-access.js";

/** How deep a skills root is walked for nested skill directories. */
const SKILL_DEPTH = 4;
/** Files read per root at most (a misconfigured root pointing at a big tree). */
const MAX_FILES_PER_ROOT = 400;
/** `claude plugin list --json` wall-clock limit (it takes ~0.6 s). */
export const PLUGIN_LIST_TIMEOUT_MS = 10_000;

type Origin = Pick<SlashCommand, "source" | "plugin">;

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

async function entriesOf(dir: string): Promise<Dirent[]> {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

/** Directory / file kind of an entry, following a symlink (a broken one is neither). */
async function kindOf(
  dir: string,
  entry: Dirent,
): Promise<"dir" | "file" | undefined> {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return undefined;
  const stats = await stat(join(dir, entry.name)).catch(() => undefined);
  if (stats?.isDirectory()) return "dir";
  if (stats?.isFile()) return "file";
  return undefined;
}

/** Every `SKILL.md` under `root` (see the header for the walk). */
export async function findSkillFiles(
  root: string,
  depth = SKILL_DEPTH,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    if (found.length >= MAX_FILES_PER_ROOT) return;
    const entries = await entriesOf(dir);
    const skill = entries.find((entry) => entry.name === "SKILL.md");
    if (skill && (await kindOf(dir, skill)) === "file") {
      found.push(join(dir, "SKILL.md"));
      return;
    }
    if (level >= depth) return;
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if ((await kindOf(dir, entry)) === "dir") subdirs.push(entry.name);
    }
    for (const name of subdirs.sort()) await walk(join(dir, name), level + 1);
  };
  // The root itself is never a skill: start at its children.
  const entries = await entriesOf(root);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if ((await kindOf(root, entry)) === "dir") {
      await walk(join(root, entry.name), 1);
    }
  }
  return found;
}

/** Every `.md` file under `root` (subdirectories too when `nested`), sorted. */
export async function findCommandFiles(
  root: string,
  nested: boolean,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    for (const entry of await entriesOf(dir)) {
      if (found.length >= MAX_FILES_PER_ROOT) return;
      if (entry.name.startsWith(".")) continue;
      const kind = await kindOf(dir, entry);
      if (kind === "file" && extname(entry.name) === ".md") {
        found.push(join(dir, entry.name));
      } else if (kind === "dir" && nested && level < SKILL_DEPTH) {
        await walk(join(dir, entry.name), level + 1);
      }
    }
  };
  await walk(root, 0);
  return found.sort();
}

interface SkillOptions extends Origin {
  /** The prompt text for a skill named `name` (`/name`, `/skill:name`, `$name`). */
  command: (name: string) => string;
  /** Pi loads no skill without a description. */
  requireDescription?: boolean;
  /** Claude hides `user-invocable: false` skills from its menu. */
  honorUserInvocable?: boolean;
  /** How deep skills nest under a root (Claude: `skills/<name>/SKILL.md` only). */
  depth?: number;
}

/** One `SKILL.md` as a menu entry: frontmatter `name`, else its directory's name. */
export async function readSkill(
  file: string,
  options: SkillOptions,
): Promise<SlashCommand | undefined> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  const { data, body } = parseFrontmatter(text);
  if (options.honorUserInvocable && data["user-invocable"] === false) {
    return undefined;
  }
  const name = frontmatterString(data, "name") ?? basename(dirname(file));
  if (/\s/.test(name)) return undefined;
  const declared = frontmatterString(data, "description");
  if (options.requireDescription && !declared) return undefined;
  const description = declared ?? firstLine(body);
  const argumentHint = frontmatterString(data, "argument-hint");
  return {
    command: options.command(name),
    kind: "skill",
    source: options.source,
    ...(options.plugin ? { plugin: options.plugin } : {}),
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

/** One command / prompt-template `.md` file as a menu entry named by `command`. */
export async function readCommand(
  file: string,
  command: string,
  origin: Origin,
): Promise<SlashCommand | undefined> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  const { data, body } = parseFrontmatter(text);
  const description = frontmatterString(data, "description") ?? firstLine(body);
  const argumentHint = frontmatterString(data, "argument-hint");
  return {
    command,
    kind: "command",
    source: origin.source,
    ...(origin.plugin ? { plugin: origin.plugin } : {}),
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

async function skillsIn(
  roots: readonly string[],
  options: SkillOptions,
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const root of roots) {
    for (const file of await findSkillFiles(root, options.depth)) {
      const entry = await readSkill(file, options);
      if (entry) out.push(entry);
    }
  }
  return out;
}

async function commandsIn(
  roots: readonly string[],
  nested: boolean,
  name: (file: string, root: string) => string,
  origin: Origin,
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const root of roots) {
    for (const file of await findCommandFiles(root, nested)) {
      const entry = await readCommand(file, name(file, root), origin);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** The first entry per `command` wins (agents keep the first one they find). */
export function dedupeSlashCommands(
  entries: readonly SlashCommand[],
): SlashCommand[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.command)) return false;
    seen.add(entry.command);
    return true;
  });
}

/** `.agents/skills` in `cwd` and each parent up to its git root (the filesystem root without one), as Pi and Codex walk it. */
export function ancestorAgentsSkillDirs(cwd: string): string[] {
  const start = resolve(cwd);
  let gitRoot: string | undefined;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      gitRoot = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(join(dir, ".agents", "skills"));
    if (dir === gitRoot || dirname(dir) === dir) break;
  }
  return dirs;
}

function fileStem(file: string): string {
  return basename(file, extname(file));
}

// --- Claude Code --------------------------------------------------------

export interface ClaudeSlashCommandAccessOptions {
  /** Claude's config directory; defaults to `$CLAUDE_CONFIG_DIR` / `~/.claude`. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** One `claude plugin list --json` row (the fields used). */
interface PluginRow {
  id?: unknown;
  enabled?: unknown;
  projectEnabled?: unknown;
  installPath?: unknown;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export class ClaudeSlashCommandAccess implements HarnessSlashCommandAccess {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: ClaudeSlashCommandAccessOptions = {}) {
    this.env = options.env ?? process.env;
  }

  async listSlashCommands(cwd?: string): Promise<SlashCommand[]> {
    const configDir = this.options.configDir ?? claudeConfigDir(this.env);
    const own = async (base: string, source: "user" | "project") => [
      ...(await skillsIn([join(base, "skills")], {
        command: (name) => `/${name}`,
        source,
        honorUserInvocable: true,
        depth: 1,
      })),
      ...(await commandsIn(
        [join(base, "commands")],
        true,
        (file) => `/${fileStem(file)}`,
        { source },
      )),
    ];
    const [project, user, plugins] = await Promise.all([
      cwd ? own(join(cwd, ".claude"), "project") : [],
      own(configDir, "user"),
      this.pluginCommands(cwd),
    ]);
    return dedupeSlashCommands([...project, ...user, ...plugins]);
  }

  /** Enabled plugins' skills and commands; none when the listing fails. */
  private async pluginCommands(cwd?: string): Promise<SlashCommand[]> {
    const outcome = await runOutcome(
      // The same override the Claude Code adapter launches with (e2e fakes).
      this.env.HARBORMASTER_CLAUDE_COMMAND || "claude",
      ["plugin", "list", "--json"],
      {
        timeoutMs: this.options.timeoutMs ?? PLUGIN_LIST_TIMEOUT_MS,
        ...(cwd ? { cwd } : {}),
      },
    ).catch(() => undefined);
    if (!outcome?.ok) return [];
    let rows: unknown;
    try {
      rows = JSON.parse(outcome.stdout);
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];
    const lists = await Promise.all(
      (rows as PluginRow[])
        .filter(
          (row) =>
            (row.enabled === true || row.projectEnabled === true) &&
            typeof row.installPath === "string",
        )
        .map((row) =>
          this.pluginEntries(
            row.installPath as string,
            typeof row.id === "string" ? row.id : "",
          ),
        ),
    );
    return lists.flat();
  }

  private async pluginEntries(
    installPath: string,
    id: string,
  ): Promise<SlashCommand[]> {
    let manifest: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(
        (await readText(join(installPath, ".claude-plugin", "plugin.json"))) ??
          "{}",
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        manifest = parsed as Record<string, unknown>;
      }
    } catch {
      // A broken manifest: the id names the plugin, default paths only.
    }
    const plugin =
      (typeof manifest.name === "string" && manifest.name.trim()) ||
      id.split("@")[0] ||
      basename(installPath);
    const extra = (key: string) =>
      stringList(manifest[key]).map((path) => resolve(installPath, path));
    const origin = { source: "plugin" as const, plugin };
    const skills = await skillsIn(
      [join(installPath, "skills"), ...extra("skills")],
      {
        command: (name) => `/${plugin}:${name}`,
        ...origin,
        honorUserInvocable: true,
        depth: 1,
      },
    );
    const commands: SlashCommand[] = [];
    for (const path of [join(installPath, "commands"), ...extra("commands")]) {
      if (extname(path) === ".md") {
        const entry = await readCommand(
          path,
          `/${plugin}:${fileStem(path)}`,
          origin,
        );
        if (entry) commands.push(entry);
        continue;
      }
      commands.push(
        ...(await commandsIn(
          [path],
          true,
          (file, root) =>
            `/${plugin}:${relative(root, file).slice(0, -3).split(/[\\/]/).join(":")}`,
          origin,
        )),
      );
    }
    return [...skills, ...commands];
  }
}

// --- Pi -----------------------------------------------------------------

export interface PiSlashCommandAccessOptions {
  /** Pi's agent dir; defaults to `$PI_CODING_AGENT_DIR` / `~/.pi/agent`. */
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export class PiSlashCommandAccess implements HarnessSlashCommandAccess {
  constructor(private readonly options: PiSlashCommandAccessOptions = {}) {}

  async listSlashCommands(cwd?: string): Promise<SlashCommand[]> {
    const env = this.options.env ?? process.env;
    const home = this.options.home ?? homedir();
    const agentDir =
      this.options.agentDir ??
      (env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"));
    const skill = (source: "user" | "project") => ({
      command: (name: string) => `/skill:${name}`,
      source,
      requireDescription: true,
    });
    const prompt = (file: string) => `/${fileStem(file)}`;
    const userAgents = join(home, ".agents", "skills");
    const projectAgents = cwd
      ? ancestorAgentsSkillDirs(cwd).filter((dir) => dir !== userAgents)
      : [];
    const [projectSkills, userSkills, projectPrompts, userPrompts] =
      await Promise.all([
        cwd
          ? skillsIn(
              [join(cwd, ".pi", "skills"), ...projectAgents],
              skill("project"),
            )
          : [],
        skillsIn([join(agentDir, "skills"), userAgents], skill("user")),
        cwd
          ? commandsIn([join(cwd, ".pi", "prompts")], false, prompt, {
              source: "project",
            })
          : [],
        commandsIn([join(agentDir, "prompts")], false, prompt, {
          source: "user",
        }),
      ]);
    // Pi loads user resources before project ones; the first name wins.
    return dedupeSlashCommands([
      ...userPrompts,
      ...projectPrompts,
      ...userSkills,
      ...projectSkills,
    ]);
  }
}

// --- Codex --------------------------------------------------------------

export interface CodexSlashCommandAccessOptions {
  /** `$CODEX_HOME`; defaults to it, else `~/.codex`. */
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export class CodexSlashCommandAccess implements HarnessSlashCommandAccess {
  constructor(private readonly options: CodexSlashCommandAccessOptions = {}) {}

  async listSlashCommands(cwd?: string): Promise<SlashCommand[]> {
    const env = this.options.env ?? process.env;
    const home = this.options.home ?? homedir();
    const codexHome =
      this.options.codexHome ?? (env.CODEX_HOME || join(home, ".codex"));
    const userAgents = join(home, ".agents", "skills");
    const skill = (source: "user" | "project") => ({
      command: (name: string) => `$${name}`,
      source,
    });
    const [project, user] = await Promise.all([
      cwd
        ? skillsIn(
            ancestorAgentsSkillDirs(cwd).filter((dir) => dir !== userAgents),
            skill("project"),
          )
        : [],
      skillsIn(
        [
          join(codexHome, "skills"),
          userAgents,
          join(codexHome, "skills", ".system"),
        ],
        skill("user"),
      ),
    ]);
    return dedupeSlashCommands([...project, ...user]);
  }
}
