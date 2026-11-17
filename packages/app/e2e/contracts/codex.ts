// Codex CLI's contract rows (docs/harness-additions.md P5, X1-X11).
// Observed on the pinned 0.169.0 in a pty, keyless: a fresh CODEX_HOME with
// a `model_providers` entry pointing at a local canned Responses-API stub
// runs turns, tools, hooks, `queue` and skills without any model or login
// (packages/app/tests/real-cli-smoke.test.ts asserts every keyless row).
// `fake-codex.ts` replays these rows and nothing else.

import { defineContract } from "./types";

/** Codex's binary version the rows were observed on (T3's pin). */
export const CODEX_CONTRACT_VERSION = "0.169.0";

export const CODEX_CONTRACT = defineContract("codex", CODEX_CONTRACT_VERSION, [
  {
    id: "codex.version",
    title: "--version prints 'codex-cli <semver>'",
    kind: "command",
    needsModel: false,
    detail:
      "Onboarding/doctor detection runs `codex --version` and parses the first semver.",
    facts: {
      args: ["--version"],
      output: `codex-cli ${CODEX_CONTRACT_VERSION}`,
      pattern: "^codex-cli (\\d+\\.\\d+\\.\\d+)$",
    },
  },
  {
    id: "codex.argv.hooks",
    title:
      "--enable hooks --dangerously-bypass-hook-trust -c hooks.<Event>=[…] runs per-session hooks",
    kind: "argv",
    needsModel: false,
    detail:
      "Each `-c hooks.<Event>=[{hooks=[{type=\"command\",command='''…''',timeout=10}]}]` (TOML) adds a command hook for this run only; the trust bypass runs them without a persisted trust entry; nothing is written to CODEX_HOME.",
    facts: {
      flags: ["--enable", "hooks", "--dangerously-bypass-hook-trust"],
      events: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"],
      overridePrefix: "hooks.",
      commandPattern: "command='''(.*?)'''",
    },
  },
  {
    id: "codex.hook.command-shell",
    title:
      "hook commands run through a shell with the session env and the event JSON on stdin",
    kind: "hook",
    needsModel: false,
    detail:
      "The command string is run by `sh -c` (quoting honored), inherits the session's env (HARBORMASTER_* identity), gets the event JSON on stdin; its stdout is parsed as JSON. Codex waits for the hook (X2: ours replies at once).",
    facts: {
      inheritedEnv: "HARBORMASTER_TASK_ID",
      stdinKeys: [
        "session_id",
        "transcript_path",
        "cwd",
        "hook_event_name",
        "model",
        "permission_mode",
      ],
    },
  },
  {
    id: "codex.hook.session-start",
    title:
      "SessionStart fires with the first submitted prompt and names the session id + rollout",
    kind: "hook",
    needsModel: false,
    detail:
      "Not at TUI start: right before the first UserPromptSubmit of a run (new, resumed or forked), `source` = startup/resume. `session_id` is Codex's own id (no `--session-id` exists); `transcript_path` the rollout. Core binds the task to both (X3).",
    facts: {
      event: "SessionStart",
      stdinKeys: ["session_id", "transcript_path", "source"],
      newSource: "startup",
    },
  },
  {
    id: "codex.hook.user-prompt-submit",
    title:
      "UserPromptSubmit runs on a submitted prompt; additionalContext reaches the model",
    kind: "hook",
    needsModel: false,
    detail:
      "Fires before the model call with `prompt` and `turn_id`; `hookSpecificOutput.additionalContext` is added as a developer message (catch-up delivery).",
    facts: {
      event: "UserPromptSubmit",
      stdinKeys: ["session_id", "turn_id", "prompt"],
      outputKey: "additionalContext",
    },
  },
  {
    id: "codex.hook.post-tool-use",
    title:
      "PostToolUse runs after each tool; additionalContext reaches the model",
    kind: "hook",
    needsModel: false,
    detail:
      "Fires after every tool call (no matcher) with `tool_name` (Codex's `exec_command` shell tool is reported as `Bash`); `hookSpecificOutput.additionalContext` is added as a developer message before the tool output goes back (steer delivery).",
    facts: {
      event: "PostToolUse",
      stdinKeys: ["session_id", "turn_id", "tool_name"],
      toolName: "Bash",
      outputKey: "additionalContext",
    },
  },
  {
    id: "codex.hook.stop",
    title: "Stop runs at the end of a turn; `{}` lets it stop",
    kind: "hook",
    needsModel: false,
    detail:
      "Stdin carries `stop_hook_active: false` and the turn's `last_assistant_message`.",
    facts: {
      event: "Stop",
      stdinKeys: ["session_id", "turn_id", "stop_hook_active"],
      allow: "{}",
    },
  },
  {
    id: "codex.argv.mcp",
    title:
      "-c mcp_servers.harbormaster.{command,args,env,cwd} starts our MCP server",
    kind: "argv",
    needsModel: false,
    detail:
      "Spawned with that env (identity only) after start; tools appear as `mcp__harbormaster__*`.",
    facts: { prefix: "mcp_servers.harbormaster.", args: ["mcp"] },
  },
  {
    id: "codex.argv.resume",
    title:
      "options, then `resume <id>`, reopen that session with its history and id",
    kind: "argv",
    needsModel: false,
    detail:
      "Every global option (`-c`, `--enable`, bypass, `-m`) goes before the subcommand and applies to it; hooks report the same `session_id`; the next request carries the earlier turns. `resume --last` reopens the newest session for the cwd.",
    facts: { subcommand: "resume", last: "--last" },
  },
  {
    id: "codex.argv.fork",
    title: "`fork <id>` starts a new session id carrying the source's history",
    kind: "argv",
    needsModel: false,
    detail:
      "The fork's rollout records `forked_from_id` and references (does not copy) the parent's history; hooks report the new id.",
    facts: { subcommand: "fork", metaKey: "forked_from_id" },
  },
  {
    id: "codex.argv.bypass",
    title:
      "--dangerously-bypass-approvals-and-sandbox runs in bypassPermissions mode",
    kind: "argv",
    needsModel: false,
    detail:
      "Launched children run without approvals or sandbox (R7, X7); hooks report the mode. A resumed session keeps the mode it was created with (a bypass-launched task reopened in an interactive pane still runs in bypass).",
    facts: {
      flag: "--dangerously-bypass-approvals-and-sandbox",
      permissionMode: "bypassPermissions",
      defaultMode: "default",
      resumeKeeps: "bypassPermissions",
    },
  },
  {
    id: "codex.sandbox.network",
    title:
      "the workspace-write sandbox denies binding a loopback port unless sandbox_workspace_write.network_access=true",
    kind: "argv",
    needsModel: false,
    detail:
      "Codex's default sandbox for an interactive (non-bypass) session blocks the network, a local listen() included (EPERM), so `plannotator review` fails ('port … already in use'). Every Harbormaster launch adds `-c sandbox_workspace_write.network_access=true` (X12); the approvals policy is unchanged.",
    facts: {
      override: "sandbox_workspace_write.network_access=true",
      mode: 'sandbox_mode="workspace-write"',
      denied: "EPERM",
    },
  },
  {
    id: "codex.argv.model",
    title: "-m <model> picks the model (hooks report it)",
    kind: "argv",
    needsModel: false,
    detail: "The first launch passes the task's model; hooks carry `model`.",
    facts: { flag: "-m" },
  },
  {
    id: "codex.prompt.after-dashdash",
    title: "the initial prompt follows `--` and runs as the first turn",
    kind: "prompt",
    needsModel: false,
    detail:
      "After `--` a prompt starting with '-' stays text; UserPromptSubmit sees it verbatim, also after `resume <id>`.",
    facts: { separator: "--" },
  },
  {
    id: "codex.status.no-probe",
    title: "reports OSC 7501 without a probe: idle at its prompt",
    kind: "status",
    needsModel: false,
    detail:
      "No `ESC ] 7501 ; ?` is ever sent; `state=idle:app=codex` once the prompt is up (after the folder-trust dialog, which reports nothing).",
    facts: { ready: "state=idle:app=codex", probe: "\u001b]7501;?" },
  },
  {
    id: "codex.status.turn",
    title: "a turn reports working, then OSC 9 '<reply>' right before done",
    kind: "status",
    needsModel: false,
    detail:
      'With `-c tui.notifications=[…] -c tui.notification_method="osc9" -c tui.notification_condition="always"`, the turn\'s last reply arrives as `ESC ] 9 ; <text> BEL` immediately before `state=done` (X4).',
    facts: {
      working: "state=working:app=codex",
      done: "state=done:app=codex",
      osc9: "\u001b]9;",
      overrides: [
        'tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"]',
        'tui.notification_method="osc9"',
        'tui.notification_condition="always"',
      ],
    },
  },
  {
    id: "codex.status.blocked",
    title:
      "reports blocked (kind permission, no message) on an approval prompt",
    kind: "status",
    needsModel: true,
    detail:
      "Recorded with a logged-in model (fixture permission): `state=blocked:kind=permission:app=codex`; declining with Esc ends idle.",
    facts: { report: "state=blocked:kind=permission:app=codex" },
  },
  {
    id: "codex.queue",
    title:
      "`codex queue --thread <id> --message <text>` runs a turn in a live idle session",
    kind: "command",
    needsModel: false,
    detail:
      "Exits 0 with 'Queued message <id> for thread <id>.'; the idle TUI submits the text as its next prompt (UserPromptSubmit sees it verbatim), so idle wake-up and follow-up need no keystrokes (X5).",
    facts: {
      args: ["queue", "--thread", "<id>", "--message", "<text>"],
      reply: "Queued message ",
    },
  },
  {
    id: "codex.command.skill",
    title:
      "`$<name>` runs the user skill <CODEX_HOME>/skills/<name>/SKILL.md (typed or queued)",
    kind: "command",
    needsModel: false,
    detail:
      "The skill body is injected into the turn; `~/.agents/skills/<name>` (where Plannotator's install script puts its skills) counts too.",
    facts: {
      mention: "$",
      file: "skills/<name>/SKILL.md",
      agentsDir: ".agents/skills",
    },
  },
  {
    id: "codex.command.skill-popup",
    title:
      "a typed bare `$<name>` opens a completion popup: Enter inserts, ' ' + Enter submits",
    kind: "command",
    needsModel: false,
    detail:
      "Typing the skill name then Enter only completes it; a trailing space closes the popup so Enter submits (the typing fallback adds it).",
    facts: { submitSuffix: " " },
  },
  {
    id: "codex.review.plannotator-skill",
    title: "$plannotator-review (Plannotator's skill) runs plannotator review",
    kind: "command",
    needsModel: true,
    detail:
      "Needs Plannotator's real skill and a model to follow it; the review opens through PLANNOTATOR_BROWSER (real smoke).",
    facts: {
      command: "$plannotator-review",
      runs: ["plannotator", "review"],
    },
  },
  {
    id: "codex.session-file.layout",
    title:
      "rollout at <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<start ts>-<id>.jsonl, written with the first prompt",
    kind: "session-file",
    needsModel: false,
    detail:
      "Named after the session's start time but written only once a prompt is submitted (an idle session has none, like its SessionStart); `transcript_path` in every hook is this file; each response adds a `token_usage_record` line ({ usage: { input_tokens, cached_input_tokens, output_tokens, … } }) after a `turn_context` naming the model (X11).",
    facts: {
      dir: "sessions",
      prefix: "rollout-",
      suffix: ".jsonl",
      usageType: "token_usage_record",
    },
  },
  {
    id: "codex.env.home",
    title: "CODEX_HOME relocates config, sessions, skills and the queue",
    kind: "env",
    needsModel: false,
    detail:
      "Everything Codex reads or writes lives under it (default ~/.codex); `codex queue` finds the session through the same home.",
    facts: { env: "CODEX_HOME", fallback: ".codex" },
  },
  {
    id: "codex.trust.folder",
    title: "a never-trusted git folder shows 'Trust this folder?' first",
    kind: "trust",
    needsModel: false,
    detail:
      'Only in a git repository (every task worktree is one; a plain folder never asks). Before the prompt (no 7501 report while shown); Enter on \'1. Trust and continue\' records `[projects."<real path>"] trust_level = "trusted"` in <CODEX_HOME>/config.toml (X8). A `-c projects…trust_level` override does not suppress it, nor does `--dangerously-bypass-approvals-and-sandbox`.',
    facts: {
      question: "Trust this folder?",
      accept: "Trust and continue",
      persisted: 'trust_level = "trusted"',
    },
  },
]);

export type CodexRowId = (typeof CODEX_CONTRACT.rows)[number]["id"];
