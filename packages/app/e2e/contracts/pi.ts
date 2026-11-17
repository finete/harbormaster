// Pi's contract rows (docs/harness-additions.md P5). Observed on the pinned
// 1.5.2 in a pty, keyless: a `models.json` provider pointing at a local
// canned Messages-API stub runs turns without any model
// (packages/app/tests/real-cli-smoke.test.ts asserts every keyless row).
// `fake-pi.ts` replays these rows and nothing else.

import { defineContract } from "./types";

/** Pi's binary version the rows were observed on (T3's pin). */
export const PI_CONTRACT_VERSION = "1.5.2";

export const PI_CONTRACT = defineContract("pi", PI_CONTRACT_VERSION, [
  {
    id: "pi.version",
    title: "--version prints the bare semver",
    kind: "command",
    needsModel: false,
    detail:
      "Onboarding/doctor detection runs `pi --version` and parses the first semver (no 'pi' prefix).",
    facts: {
      args: ["--version"],
      output: PI_CONTRACT_VERSION,
      pattern: "^(\\d+\\.\\d+\\.\\d+)$",
    },
  },
  {
    id: "pi.argv.session-id",
    title: "--session-id <id> creates (or reopens) the session with that id",
    kind: "argv",
    needsModel: false,
    detail:
      "Core pre-assigns the id; for an id without a file Pi says so and creates the session under it, in the cwd's session dir.",
    facts: {
      flag: "--session-id",
      createNotice: "No project session found with id",
    },
  },
  {
    id: "pi.argv.session",
    title: "--session <path> reopens that session file",
    kind: "argv",
    needsModel: false,
    detail: "The next turn carries the file's history and appends to it.",
    facts: { flag: "--session" },
  },
  {
    id: "pi.argv.fork",
    title: "--fork <path> --session-id <id> forks into a new id",
    kind: "argv",
    needsModel: false,
    detail:
      "A new file named after <id> whose header names the source (`parentSession`); the history comes along.",
    facts: { flags: ["--fork", "--session-id"], headerKey: "parentSession" },
  },
  {
    id: "pi.prompt.after-dashdash",
    title: "the initial prompt follows `--` and is submitted as the first turn",
    kind: "prompt",
    needsModel: false,
    detail: "Sent verbatim as the first user message.",
    facts: { separator: "--" },
  },
  {
    id: "pi.prompt.at-file",
    title: "a prompt starting with '@' is a file attachment, even after `--`",
    kind: "prompt",
    needsModel: false,
    detail:
      "A missing file is an error and Pi exits; the adapter shields a leading '@' with a space, which Pi sends as text.",
    facts: { error: "File not found:", shield: " @" },
  },
  {
    id: "pi.env.program-status",
    title:
      "with PI_PROGRAM_STATUS=1 Pi reports OSC 7501 without probing, idle first",
    kind: "env",
    needsModel: false,
    detail:
      "Harbormaster always sets it; Pi then never sends the probe and reports `idle` at start.",
    facts: {
      env: "PI_PROGRAM_STATUS",
      value: "1",
      firstReport: "state=idle:app=pi",
    },
  },
  {
    id: "pi.status.probe-when-unset",
    title: "without PI_PROGRAM_STATUS Pi probes and waits for the answer",
    kind: "status",
    needsModel: false,
    detail:
      "Sends `ESC ] 7501 ; ?`; reports (idle first) only after the terminal answered.",
    facts: { probe: "\u001b]7501;?", firstReport: "state=idle:app=pi" },
  },
  {
    id: "pi.status.turn",
    title: "reports working during a turn, then done",
    kind: "status",
    needsModel: false,
    detail: "Every report carries `app=pi`.",
    facts: {
      working: "state=working:app=pi",
      done: "state=done:app=pi",
      app: "app=pi",
    },
  },
  {
    id: "pi.status.blocked-error",
    title: "reports blocked / error with kind and message",
    kind: "status",
    needsModel: true,
    detail:
      "`state=blocked:kind=<kind>:msg=<base64>` while asking the user, `state=error` on a failed turn; only a model turn produces them.",
    facts: { blocked: "state=blocked", error: "state=error" },
  },
  {
    id: "pi.process.pid",
    title: "Pi runs in the pane's own process",
    kind: "env",
    needsModel: false,
    detail:
      "No wrapper process: `process.pid` inside Pi (and its extensions) is the pty child's pid, which presence records must carry.",
    facts: { samePid: true },
  },
  {
    id: "pi.extension.autoload",
    title: "*.ts in <agentDir>/extensions load at start with the session's env",
    kind: "env",
    needsModel: false,
    detail:
      "Harbormaster's inbox extension is copied there as harbormaster-inbox.ts; `session_start` gives it the session id and file; HARBORMASTER_* env is visible.",
    facts: {
      dir: "extensions",
      file: "harbormaster-inbox.ts",
      env: "PI_CODING_AGENT_DIR",
    },
  },
  {
    id: "pi.extension.mcp-server",
    title: "a registered MCP server is spawned at session start",
    kind: "env",
    needsModel: false,
    detail:
      "The inbox extension registers HARBORMASTER_MCP_SERVER (`{ command, args, env, cwd }`) as `harbormaster`; Pi spawns `command args` with that env right away.",
    facts: {
      env: "HARBORMASTER_MCP_SERVER",
      name: "harbormaster",
      args: ["mcp"],
    },
  },
  {
    id: "pi.extension.inbox",
    title:
      "the inbox extension claims over HARBORMASTER_SOCKET and wakes an idle session",
    kind: "hook",
    needsModel: false,
    detail:
      "On session_start it opens `watch-inbox` and claims (`inbox_claim`, `idle: true` when idle); an idle claim's message starts a turn with its text.",
    facts: {
      env: "HARBORMASTER_SOCKET",
      watch: "watch-inbox",
      claim: "inbox_claim",
    },
  },
  {
    id: "pi.command.unknown-slash",
    title: "an unknown slash command goes to the model as plain text",
    kind: "command",
    needsModel: false,
    detail:
      "Pi has no 'Unknown command' reply: `/name` that no extension/skill registers is sent as a prompt (why the Review button needs Plannotator's extension).",
    facts: { noReply: "Unknown command" },
  },
  {
    id: "pi.command.extension",
    title: "an extension-registered slash command runs locally",
    kind: "command",
    needsModel: false,
    detail:
      "`pi.registerCommand(name, …)` handles `/name` typed at the prompt (Enter submits) without a model call.",
    facts: { submit: "\r" },
  },
  {
    id: "pi.review.plannotator",
    title: "/plannotator-review is Plannotator's Pi extension command",
    kind: "command",
    needsModel: true,
    detail:
      "Needs `@plannotator/pi-extension` installed; runs the review in the session's pty and env (real smoke).",
    facts: { command: "/plannotator-review", runs: ["plannotator", "review"] },
  },
  {
    id: "pi.tools.mcp-call",
    title: "the model calls Harbormaster tools through the MCP server",
    kind: "hook",
    needsModel: true,
    detail:
      "Tools appear as `mcp__harbormaster__<tool>`; shells see HARBORMASTER_CLI. Only a model turn calls them.",
    facts: { prefix: "mcp__harbormaster__", cliEnv: "HARBORMASTER_CLI" },
  },
  {
    id: "pi.session-file.layout",
    title:
      "session file at <agentDir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl",
    kind: "session-file",
    needsModel: false,
    detail:
      "cwd = the real path (symlinks resolved), leading '/' dropped, separators as '-'. First line `{ type: 'session', version: 3, id, timestamp, cwd }`. Written once the first turn completed, not at start.",
    facts: {
      dir: "sessions",
      header: { type: "session", version: 3 },
      headerKeys: ["type", "version", "id", "timestamp", "cwd"],
    },
  },
  {
    id: "pi.session-file.usage",
    title: "assistant entries carry usage and Pi's cost estimate",
    kind: "session-file",
    needsModel: false,
    detail:
      "`{ type: 'message', message: { role: 'assistant', provider, model, usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { …, total } } } }`.",
    facts: {
      usageKeys: [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "totalTokens",
        "cost",
      ],
      costKey: "total",
    },
  },
]);

export type PiRowId = (typeof PI_CONTRACT.rows)[number]["id"];
