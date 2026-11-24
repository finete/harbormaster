// Resource Access: the herdr reader of "import existing work" (docs/import.md
// I2, F7). herdr is a terminal workspace manager; each herdr *session*
// (`default` plus named ones) keeps a `session.json` under its session dir:
//
//   default  → <config>/herdr/session.json
//   named    → <config>/herdr/sessions/<name>/session.json
//
// where <config> is `$XDG_CONFIG_HOME` else `~/.config`. The reader turns
// every workspace pane into one `ImportOrchestratorRecord` per folder
// (pane cwd, else the workspace `identity_cwd`) carrying the workspace's
// `custom_name` and the agent sessions herdr recorded for its panes.
//
// Snapshot formats follow herdr's own `src/persist/snapshot.rs`: versions 0-3
// parse (`SNAPSHOT_VERSION = 3`; a missing `version` is 0), a newer one is
// refused, and a workspace is either current (`identity_cwd` + `tabs[]`) or
// the pre-tabs legacy shape (`layout` + `panes`, no id and no identity cwd:
// herdr uses the root pane's cwd). A version we cannot read is an `error` on
// the reading, never a throw.
//
// Live state comes from the herdr CLI, spawned only for `session list --json`
// and `api snapshot` (`herdr --session <name> api snapshot` for a named
// session) with a short timeout. A missing binary, a stopped server or any
// failure means "nothing live": the file data is still returned.
//
// Roots are constructor options (`home` / `configDir`, the `herdr` binary)
// so tests and e2e point them at fixture copies.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  ImportOrchestratorRecord,
  ImportOrchestratorSessionRef,
  ImportReadOptions,
  ImportSourceReader,
  ImportSourceReading,
} from "../contracts/import.js";
import { tryRun } from "../utilities/run.js";

/** The newest snapshot version this reader (and herdr 0.9.x) understands. */
export const HERDR_SNAPSHOT_VERSION = 3;

/** Wall-clock limit for each `herdr` spawn. */
export const HERDR_IMPORT_TIMEOUT_MS = 4_000;

/** herdr's agent name → our harness id. Other agents (omp, gemini, …) have no adapter. */
const HARNESS_BY_HERDR_AGENT: Readonly<Record<string, string>> = {
  claude: "claude-code",
  codex: "codex",
  pi: "pi",
  cursor: "cursor",
};

export interface HerdrImportAccessOptions {
  /** Home folder (config defaults to `<home>/.config/herdr`). Default: the OS home. */
  home?: string;
  /** The herdr config dir itself (the one holding `session.json`). Overrides `$XDG_CONFIG_HOME` and `home`. */
  configDir?: string;
  /** Environment to read `XDG_CONFIG_HOME` from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The `herdr` binary. Default: `herdr` from PATH. */
  herdrBinary?: string;
  /** Per-spawn time limit. Default {@link HERDR_IMPORT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

interface SessionDir {
  name: string;
  dir: string;
  /** `undefined` = unknown (no `session list` answer). */
  running?: boolean;
}

interface PaneEntry {
  cwd: string;
  /** Internal pane id as stored in `session.json`. */
  paneId: string;
  agentName?: string;
  sessions: ImportOrchestratorSessionRef[];
}

interface WorkspaceEntry {
  id?: string;
  customName?: string;
  identityCwd?: string;
  /** Internal pane id → public pane number (`w1:p<n>` in the live API). */
  publicPaneNumbers: Record<string, number>;
  panes: PaneEntry[];
}

interface LivePane {
  workspaceId?: string;
  paneId?: string;
  cwd?: string;
  agent?: string;
  session?: ImportOrchestratorSessionRef;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function harnessFor(agent: string): string | undefined {
  return HARNESS_BY_HERDR_AGENT[agent];
}

function sessionRef(
  agent: string,
  kind: unknown,
  value: unknown,
): ImportOrchestratorSessionRef | undefined {
  const text = str(value);
  if (!text) return undefined;
  const harness = harnessFor(agent);
  const base = { agent, ...(harness ? { harness } : {}) };
  if (kind === "path") return { ...base, sessionPath: text };
  if (kind === "id") return { ...base, sessionId: text };
  return undefined;
}

/** The session a herdr resume command names (herdr's `agent_resume.argv`, e.g. `pi --session <file>`, `claude --resume <id>`, `codex resume <id>`). */
function sessionFromResumeArgv(
  agent: string,
  argv: unknown[],
): ImportOrchestratorSessionRef | undefined {
  const args = argv.filter(
    (entry): entry is string => typeof entry === "string",
  );
  const flag = agent === "pi" ? "--session" : "--resume";
  const flagAt = args.indexOf(flag);
  if (flagAt >= 0 && args[flagAt + 1]) {
    return sessionRef(agent, agent === "pi" ? "path" : "id", args[flagAt + 1]);
  }
  const verbAt = args.indexOf("resume");
  if (agent === "codex" && verbAt >= 0 && args[verbAt + 1]) {
    return sessionRef(agent, "id", args[verbAt + 1]);
  }
  return undefined;
}

function sameRef(
  a: ImportOrchestratorSessionRef,
  b: ImportOrchestratorSessionRef,
): boolean {
  return (
    a.agent === b.agent &&
    a.sessionId === b.sessionId &&
    a.sessionPath === b.sessionPath
  );
}

function addRef(
  refs: ImportOrchestratorSessionRef[],
  ref: ImportOrchestratorSessionRef | undefined,
): void {
  if (ref && !refs.some((existing) => sameRef(existing, ref))) refs.push(ref);
}

function parsePane(paneId: string, raw: unknown): PaneEntry | undefined {
  if (!isObject(raw)) return undefined;
  const cwd = str(raw.cwd);
  if (!cwd) return undefined;
  const sessions: ImportOrchestratorSessionRef[] = [];
  const session = raw.agent_session;
  if (isObject(session)) {
    const agent = str(session.agent);
    if (agent) addRef(sessions, sessionRef(agent, session.kind, session.value));
  }
  const resume = raw.agent_resume;
  if (sessions.length === 0 && isObject(resume) && Array.isArray(resume.argv)) {
    const agent = str(resume.agent);
    if (agent) addRef(sessions, sessionFromResumeArgv(agent, resume.argv));
  }
  const agentName = str(raw.agent_name);
  return { cwd, paneId, ...(agentName ? { agentName } : {}), sessions };
}

function parsePanes(raw: unknown): PaneEntry[] {
  if (!isObject(raw)) return [];
  return Object.entries(raw)
    .map(([paneId, pane]) => parsePane(paneId, pane))
    .filter((pane): pane is PaneEntry => pane !== undefined);
}

function legacyIdentityCwd(raw: Record<string, unknown>): string | undefined {
  const panes = isObject(raw.panes) ? raw.panes : {};
  const rootId = raw.root_pane;
  if (typeof rootId === "number" && isObject(panes[String(rootId)])) {
    const cwd = str((panes[String(rootId)] as Record<string, unknown>).cwd);
    if (cwd) return cwd;
  }
  const first = Object.keys(panes)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  if (first === undefined) return undefined;
  return str((panes[String(first)] as Record<string, unknown>).cwd);
}

/** One workspace in either shape herdr still parses; `undefined` = neither (herdr errors too). */
function parseWorkspace(raw: unknown): WorkspaceEntry | undefined {
  if (!isObject(raw)) return undefined;
  const customName = str(raw.custom_name);
  if ("identity_cwd" in raw) {
    const numbers: Record<string, number> = {};
    if (isObject(raw.public_pane_numbers)) {
      for (const [paneId, number] of Object.entries(raw.public_pane_numbers)) {
        if (typeof number === "number") numbers[paneId] = number;
      }
    }
    const tabs = Array.isArray(raw.tabs) ? raw.tabs : [];
    const id = str(raw.id);
    const identityCwd = str(raw.identity_cwd);
    return {
      ...(id ? { id } : {}),
      ...(customName ? { customName } : {}),
      ...(identityCwd ? { identityCwd } : {}),
      publicPaneNumbers: numbers,
      panes: tabs.flatMap((tab) =>
        isObject(tab) ? parsePanes(tab.panes) : [],
      ),
    };
  }
  if ("layout" in raw) {
    const identityCwd = legacyIdentityCwd(raw);
    return {
      ...(customName ? { customName } : {}),
      ...(identityCwd ? { identityCwd } : {}),
      publicPaneNumbers: {},
      panes: parsePanes(raw.panes),
    };
  }
  return undefined;
}

type ParsedSnapshot =
  | { ok: true; workspaces: WorkspaceEntry[] }
  | { ok: false; error: string };

function parseSnapshot(text: string): ParsedSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!isObject(raw)) return { ok: false, error: "not a JSON object" };
  const version = typeof raw.version === "number" ? raw.version : 0;
  if (version > HERDR_SNAPSHOT_VERSION) {
    return {
      ok: false,
      error: `snapshot version ${version} is newer than supported ${HERDR_SNAPSHOT_VERSION}`,
    };
  }
  const entries = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  const workspaces: WorkspaceEntry[] = [];
  for (const entry of entries) {
    const workspace = parseWorkspace(entry);
    if (!workspace) {
      return {
        ok: false,
        error: "a workspace is neither in the current nor the legacy format",
      };
    }
    workspaces.push(workspace);
  }
  return { ok: true, workspaces };
}

/** `result.snapshot.panes[]` of `herdr api snapshot`; a running agent is any pane that has one (the process holds its session). */
function parseLivePanes(stdout: string): LivePane[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || !isObject(raw.result)) return undefined;
  const snapshot = raw.result.snapshot;
  if (!isObject(snapshot) || !Array.isArray(snapshot.panes)) return undefined;
  const panes: LivePane[] = [];
  for (const pane of snapshot.panes) {
    if (!isObject(pane)) continue;
    const agent = str(pane.agent);
    const session = isObject(pane.agent_session)
      ? sessionRef(
          str(pane.agent_session.agent) ?? agent ?? "",
          pane.agent_session.kind,
          pane.agent_session.value,
        )
      : undefined;
    const workspaceId = str(pane.workspace_id);
    const paneId = str(pane.pane_id);
    const cwd = str(pane.cwd);
    panes.push({
      ...(workspaceId ? { workspaceId } : {}),
      ...(paneId ? { paneId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(agent ? { agent } : {}),
      ...(session ? { session } : {}),
    });
  }
  return panes;
}

function parseSessionList(stdout: string): SessionDir[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || !Array.isArray(raw.sessions)) return undefined;
  const sessions: SessionDir[] = [];
  for (const entry of raw.sessions) {
    if (!isObject(entry)) continue;
    const name = str(entry.name);
    const dir = str(entry.session_dir);
    if (!name || !dir) continue;
    sessions.push({
      name,
      dir,
      ...(typeof entry.running === "boolean" ? { running: entry.running } : {}),
    });
  }
  return sessions;
}

/** A live pane belongs to a stored pane: same workspace id and the same public number (else, with no numbers recorded, the same cwd). */
function liveMatches(
  workspace: WorkspaceEntry,
  pane: PaneEntry,
  live: LivePane,
): boolean {
  if (!workspace.id || live.workspaceId !== workspace.id) return false;
  const number = workspace.publicPaneNumbers[pane.paneId];
  if (number !== undefined) return live.paneId === `${workspace.id}:p${number}`;
  return live.cwd === pane.cwd;
}

export class ImportHerdrAccess implements ImportSourceReader {
  readonly id = "herdr" as const;
  readonly label = "herdr";

  private readonly configDir: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly spawnEnv: Record<string, string>;
  private readonly unsetEnv: string[];

  constructor(options: HerdrImportAccessOptions = {}) {
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    // An explicit `home` (tests, e2e's fake home) wins over the user's own
    // XDG_CONFIG_HOME, so it can never reach the real herdr state.
    const xdg = options.home ? undefined : env.XDG_CONFIG_HOME;
    const configRoot = xdg && xdg.length > 0 ? xdg : join(home, ".config");
    this.configDir = options.configDir ?? join(configRoot, "herdr");
    this.binary = options.herdrBinary ?? "herdr";
    this.timeoutMs = options.timeoutMs ?? HERDR_IMPORT_TIMEOUT_MS;
    // The spawned herdr must look at the same config dir this reader reads
    // (herdr derives it from XDG_CONFIG_HOME / HOME), and never at a server
    // inherited through HERDR_* variables (a pane of some other herdr).
    this.spawnEnv =
      basename(this.configDir) === "herdr"
        ? { XDG_CONFIG_HOME: dirname(this.configDir) }
        : {};
    this.unsetEnv = Object.keys(process.env).filter((name) =>
      name.startsWith("HERDR_"),
    );
  }

  async read(_options: ImportReadOptions): Promise<ImportSourceReading> {
    const sessionDirs = await this.sessionDirs();
    const orchestrations: ImportOrchestratorRecord[] = [];
    const errors: string[] = [];
    for (const session of sessionDirs) {
      const text = await readFile(
        join(session.dir, "session.json"),
        "utf8",
      ).catch(() => undefined);
      if (text === undefined) continue;
      const parsed = parseSnapshot(text);
      if (!parsed.ok) {
        errors.push(`herdr session "${session.name}": ${parsed.error}`);
        continue;
      }
      const live =
        session.running === true ? await this.livePanes(session) : undefined;
      orchestrations.push(
        ...this.records(session.name, parsed.workspaces, live),
      );
    }
    return {
      sessions: [],
      orchestrations,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  }

  /** The default session and every named one: `session list` first, plus whatever the config dir holds (the list needs the binary). */
  private async sessionDirs(): Promise<SessionDir[]> {
    const out = await tryRun(
      this.binary,
      ["session", "list", "--json"],
      undefined,
      {
        timeoutMs: this.timeoutMs,
        unsetEnv: this.unsetEnv,
        env: this.spawnEnv,
      },
    );
    const listed = out === undefined ? undefined : parseSessionList(out);
    const byName = new Map<string, SessionDir>();
    byName.set("default", { name: "default", dir: this.configDir });
    const named = await readdir(join(this.configDir, "sessions"), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of named) {
      if (entry.isDirectory()) {
        byName.set(entry.name, {
          name: entry.name,
          dir: join(this.configDir, "sessions", entry.name),
        });
      }
    }
    for (const session of listed ?? []) byName.set(session.name, session);
    return [...byName.values()];
  }

  private async livePanes(
    session: SessionDir,
  ): Promise<LivePane[] | undefined> {
    const args =
      session.name === "default"
        ? ["api", "snapshot"]
        : ["--session", session.name, "api", "snapshot"];
    const out = await tryRun(this.binary, args, undefined, {
      timeoutMs: this.timeoutMs,
      unsetEnv: this.unsetEnv,
      env: this.spawnEnv,
    });
    return out === undefined ? undefined : parseLivePanes(out);
  }

  private records(
    sessionName: string,
    workspaces: WorkspaceEntry[],
    live: LivePane[] | undefined,
  ): ImportOrchestratorRecord[] {
    const records: ImportOrchestratorRecord[] = [];
    const matched = new Set<LivePane>();
    for (const workspace of workspaces) {
      const byCwd = new Map<string, ImportOrchestratorRecord>();
      const recordFor = (cwd: string): ImportOrchestratorRecord => {
        let record = byCwd.get(cwd);
        if (!record) {
          record = {
            source: "herdr",
            orchestratorSession: sessionName,
            ...(workspace.id ? { workspaceId: workspace.id } : {}),
            ...(workspace.customName
              ? { workspaceName: workspace.customName }
              : {}),
            cwd,
            sessions: [],
            running: false,
          };
          byCwd.set(cwd, record);
          records.push(record);
        }
        return record;
      };
      for (const pane of workspace.panes) {
        const record = recordFor(pane.cwd);
        for (const ref of pane.sessions) addRef(record.sessions, ref);
        for (const livePane of live ?? []) {
          if (!liveMatches(workspace, pane, livePane)) continue;
          matched.add(livePane);
          addRef(record.sessions, livePane.session);
          if (livePane.agent) record.running = true;
        }
      }
      if (workspace.panes.length === 0 && workspace.identityCwd) {
        recordFor(workspace.identityCwd);
      }
    }
    // A pane the live server has but the file does not (not persisted yet).
    for (const livePane of live ?? []) {
      if (matched.has(livePane) || !livePane.agent || !livePane.cwd) continue;
      const known = records.find(
        (record) =>
          record.cwd === livePane.cwd &&
          record.workspaceId === livePane.workspaceId,
      );
      const record: ImportOrchestratorRecord = known ?? {
        source: "herdr",
        orchestratorSession: sessionName,
        ...(livePane.workspaceId ? { workspaceId: livePane.workspaceId } : {}),
        cwd: livePane.cwd,
        sessions: [],
        running: false,
      };
      if (!known) records.push(record);
      addRef(record.sessions, livePane.session);
      record.running = true;
    }
    return records;
  }
}
