// Claude Code's contract rows (docs/harness-additions.md P5). Observed on
// the pinned 2.1.322 in a pty, keyless: a fake API key against a local
// canned Messages-API stub runs turns and hooks without any model
// (packages/app/tests/real-cli-smoke.test.ts asserts every keyless row).
// `fake-claude.ts` replays these rows and nothing else.

import { defineContract } from "./types";

/** Claude Code's binary version the rows were observed on (T3's pin). */
export const CLAUDE_CODE_CONTRACT_VERSION = "2.1.322";

export const CLAUDE_CODE_CONTRACT = defineContract(
  "claude-code",
  CLAUDE_CODE_CONTRACT_VERSION,
  [
    {
      id: "claude.version",
      title: "--version prints '<semver> (Claude Code)'",
      kind: "command",
      needsModel: false,
      detail:
        "Onboarding/doctor detection runs `claude --version` and parses the first semver.",
      facts: {
        args: ["--version"],
        output: `${CLAUDE_CODE_CONTRACT_VERSION} (Claude Code)`,
        pattern: "^(\\d+\\.\\d+\\.\\d+) \\(Claude Code\\)$",
      },
    },
    {
      id: "claude.plugin.list-json",
      title: "plugin list --json prints a JSON array of installed plugins",
      kind: "command",
      needsModel: false,
      detail:
        "Review support reads Plannotator's plugin version from it: `[]` when none; an installed plugin is `{ id: '<plugin>@<marketplace>', version, enabled, ... }`.",
      facts: {
        args: ["plugin", "list", "--json"],
        none: "[]",
        entryKeys: ["id", "version", "enabled"],
        plannotatorId: "plannotator@plannotator",
        plannotatorVersion: "0.28.66",
      },
    },
    {
      id: "claude.argv.session-id",
      title: "--session-id <uuid> starts a new session under that id",
      kind: "argv",
      needsModel: false,
      detail:
        "Core pre-assigns the id; hooks report it as `session_id` and the transcript is named after it.",
      facts: { flag: "--session-id" },
    },
    {
      id: "claude.argv.resume",
      title: "--resume <id> reopens that session",
      kind: "argv",
      needsModel: false,
      detail:
        "The session keeps its id (hooks report it) and appends to the same transcript.",
      facts: { flag: "--resume" },
    },
    {
      id: "claude.argv.fork",
      title:
        "--resume <from> --fork-session --session-id <id> forks into a new id",
      kind: "argv",
      needsModel: false,
      detail:
        "The fork gets the id from --session-id (its own transcript) and carries the source's history.",
      facts: { flags: ["--resume", "--fork-session", "--session-id"] },
    },
    {
      id: "claude.argv.bypass",
      title: "--dangerously-skip-permissions runs in bypassPermissions mode",
      kind: "argv",
      needsModel: false,
      detail:
        "Launched children run without permission prompts (R7); hooks report the mode.",
      facts: {
        flag: "--dangerously-skip-permissions",
        permissionMode: "bypassPermissions",
      },
    },
    {
      id: "claude.argv.settings",
      title: "--settings <json> adds per-session hooks",
      kind: "argv",
      needsModel: false,
      detail:
        "Inline JSON, merged over the user's settings for this session only; its hooks run (nothing written to the config dir).",
      facts: {
        flag: "--settings",
        hookEvents: ["PostToolUse", "Stop", "UserPromptSubmit"],
      },
    },
    {
      id: "claude.argv.mcp-config",
      title: "--mcp-config <json> starts the per-session MCP server",
      kind: "argv",
      needsModel: false,
      detail:
        "Inline JSON `{ mcpServers: { harbormaster: { type: 'stdio', command, args, env } } }`; the server is spawned at start with that env. Invalid JSON is a usage error and Claude exits.",
      facts: {
        flag: "--mcp-config",
        server: "harbormaster",
        invalid: "Invalid MCP configuration",
      },
    },
    {
      id: "claude.prompt.after-dashdash",
      title:
        "the initial prompt follows `--` and is submitted as the first turn",
      kind: "prompt",
      needsModel: false,
      detail:
        "--mcp-config is variadic, so the positional prompt must follow `--`; the prompt runs as the first turn (UserPromptSubmit sees it verbatim).",
      facts: { separator: "--" },
    },
    {
      id: "claude.env.config-dir",
      title:
        "CLAUDE_CONFIG_DIR relocates config, skills, plugins and transcripts",
      kind: "env",
      needsModel: false,
      detail:
        "`.claude.json`, `skills/`, `plugins/` and `projects/` live under it (default ~/.claude).",
      facts: {
        env: "CLAUDE_CONFIG_DIR",
        skills: "skills",
        projects: "projects",
      },
    },
    {
      id: "claude.status.probe",
      title:
        "sends the OSC 7501 probe once at start; reports only if it was answered promptly",
      kind: "status",
      needsModel: false,
      detail:
        "The app's pty layer answers the probe (`ESC ] 7501 ; ? ST`). Answered within 1 s, Claude reports; not answered by ~2 s (observed: 1 s works, 2 s does not), it never reports in that session, even after a late answer.",
      facts: {
        probe: "\u001b]7501;?",
        answerHex: "1b5d373530313b3f07",
        answeredWithinMs: 1000,
        givesUpByMs: 2000,
      },
    },
    {
      id: "claude.status.ready",
      title: "after the probe answer, reports idle at its prompt",
      kind: "status",
      needsModel: false,
      detail:
        "Idle at the prompt; `working` only during a turn (see claude.status.turn).",
      facts: { report: "state=idle:app=claude-code" },
    },
    {
      id: "claude.status.turn",
      title: "reports working during a turn, then done",
      kind: "status",
      needsModel: false,
      detail:
        "A turn reports `working`; the end of the turn (after the Stop hook) reports `done`.",
      facts: {
        working: "state=working:app=claude-code",
        done: "state=done:app=claude-code",
      },
    },
    {
      id: "claude.status.blocked",
      title: "reports blocked while asking the user",
      kind: "status",
      needsModel: true,
      detail:
        "A question / permission prompt reports `state=blocked:kind=<question|permission>`; only a model turn asks one.",
      facts: { report: "state=blocked:kind=question" },
    },
    {
      id: "claude.hook.command-shell",
      title:
        "hook commands run through a shell with the session env and JSON on stdin",
      kind: "hook",
      needsModel: false,
      detail:
        "The command string is run by a shell (quoting honored), inherits the session's env (HARBORMASTER_* identity for `harbormaster hook`), gets the event JSON on stdin; its stdout is parsed as JSON.",
      facts: {
        inheritedEnv: "HARBORMASTER_TASK_ID",
        stdinKeys: ["session_id", "transcript_path", "cwd", "hook_event_name"],
      },
    },
    {
      id: "claude.hook.user-prompt-submit",
      title:
        "UserPromptSubmit runs on a submitted prompt; additionalContext reaches the model",
      kind: "hook",
      needsModel: false,
      detail:
        "Fires before the model call with the prompt text; `hookSpecificOutput.additionalContext` is added to that turn (catch-up delivery).",
      facts: {
        event: "UserPromptSubmit",
        stdinKeys: ["session_id", "hook_event_name", "prompt"],
        outputKey: "additionalContext",
      },
    },
    {
      id: "claude.hook.post-tool-use",
      title:
        "PostToolUse runs after each tool; additionalContext reaches the model",
      kind: "hook",
      needsModel: false,
      detail:
        "Fires after every tool call (no matcher) with tool_name/tool_input/tool_response; `hookSpecificOutput.additionalContext` is sent with the tool result (steer delivery).",
      facts: {
        event: "PostToolUse",
        stdinKeys: ["session_id", "hook_event_name", "tool_name", "tool_input"],
        outputKey: "additionalContext",
      },
    },
    {
      id: "claude.hook.stop",
      title: "Stop runs at the end of a turn; `{}` lets it stop",
      kind: "hook",
      needsModel: false,
      detail:
        "Stdin carries `stop_hook_active: false` on the first stop of a turn.",
      facts: {
        event: "Stop",
        stdinKeys: ["session_id", "hook_event_name", "stop_hook_active"],
        allow: "{}",
      },
    },
    {
      id: "claude.hook.stop-block",
      title:
        "Stop answering {decision:'block', reason} runs another turn with the reason",
      kind: "hook",
      needsModel: false,
      detail:
        "Follow-up delivery: the reason reaches the model as the next input; the following Stop has `stop_hook_active: true`.",
      facts: { decision: "block", reasonKey: "reason", nextActive: true },
    },
    {
      id: "claude.command.unknown",
      title: "an unknown slash command is answered 'Unknown command: /<name>'",
      kind: "command",
      needsModel: false,
      detail:
        "Answered locally, no model call; the app's review watcher matches this reply.",
      facts: { reply: "Unknown command: /" },
    },
    {
      id: "claude.command.skill",
      title:
        "a user skill <configDir>/skills/<name>/SKILL.md is the command /<name>",
      kind: "command",
      needsModel: false,
      detail:
        "Plannotator's `/plannotator-review` in Claude Code is such a user skill (not part of the plugin).",
      facts: { file: "skills/<name>/SKILL.md" },
    },
    {
      id: "claude.command.skill-live-reload",
      title: "a skill created mid-session is a known command right away",
      kind: "command",
      needsModel: false,
      detail: "Skills are re-read live; no restart needed.",
      facts: { live: true },
    },
    {
      id: "claude.command.skill-live-remove",
      title: "a skill removed mid-session is an unknown command right away",
      kind: "command",
      needsModel: false,
      detail:
        "Removing the skill directory makes `/<name>` answer 'Unknown command' in the running session.",
      facts: { live: true },
    },
    {
      id: "claude.review.plannotator-skill",
      title:
        "/plannotator-review (Plannotator's skill) runs plannotator review",
      kind: "command",
      needsModel: true,
      detail:
        "Needs Plannotator's real skill and plugin; the review opens through PLANNOTATOR_BROWSER (real smoke).",
      facts: {
        command: "/plannotator-review",
        runs: ["plannotator", "review"],
      },
    },
    {
      id: "claude.session-file.layout",
      title: "transcript at <configDir>/projects/<slug>/<sessionId>.jsonl",
      kind: "session-file",
      needsModel: false,
      detail:
        "slug = the cwd's real path (symlinks resolved: /tmp → /private/tmp on macOS) with every non-alphanumeric character replaced by '-'. Written on the first submitted input (a prompt or a slash command), not at start.",
      facts: { dir: "projects", suffix: ".jsonl", slugPattern: "[^a-zA-Z0-9]" },
    },
    {
      id: "claude.trust.folder",
      title: "a never-trusted folder shows the folder-trust dialog first",
      kind: "trust",
      needsModel: false,
      detail:
        "Before anything else (no 7501 report); confirming records `projects[<real path>].hasTrustDialogAccepted: true` in `<configDir>/.claude.json`.",
      facts: {
        question:
          "Quick safety check: Is this a project you created or one you trust?",
        accept: "Yes, I trust this folder",
        reject: "No, exit",
        persisted: "hasTrustDialogAccepted",
      },
    },
    {
      id: "claude.trust.bypass-warning",
      title: "bypass mode asks once to accept the Bypass Permissions warning",
      kind: "trust",
      needsModel: false,
      detail:
        "With --dangerously-skip-permissions, after folder trust, until accepted once (`skipDangerousModePermissionPrompt` in settings).",
      facts: {
        warning: "WARNING: Claude Code running in Bypass Permissions mode",
        accept: "Yes, I accept",
        persisted: "skipDangerousModePermissionPrompt",
      },
    },
  ],
);

export type ClaudeCodeRowId = (typeof CLAUDE_CODE_CONTRACT.rows)[number]["id"];
