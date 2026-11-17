// Cursor CLI's contract rows (docs/harness-additions.md P5, C1-C9).
// Observed on the pinned 2026.11.13-eacade1 in a real pty, logged in
// (2026-11-17), plus its `--help` and bundled sources. Keyless, Cursor
// refuses everything but `--version`, `--help` and `create-chat`
// ("Authentication required"; a `CURSOR_API_ENDPOINT` stub got only the
// JSON key exchange, then a non-HTTP/1 protocol), so every row that needs
// a session is `needsModel` and owned by the status recordings
// (tests/fixtures/status/cursor/) and the real smoke (T4).
// `fake-cursor.ts` replays these rows and nothing else.

import { defineContract } from "./types";

/** Cursor's binary version the rows were observed on (T3's pin). */
export const CURSOR_CONTRACT_VERSION = "2026.11.13-eacade1";

export const CURSOR_CONTRACT = defineContract(
  "cursor",
  CURSOR_CONTRACT_VERSION,
  [
    {
      id: "cursor.version",
      title: "--version prints the date-stamped version '<YYYY.MM.DD>-<hash>'",
      kind: "command",
      needsModel: false,
      detail:
        "Onboarding/doctor run `<alias> --version`; a generic `agent` whose output is not this form is another program (C6), so the lookup tries `cursor-agent`, then `cursor agent`.",
      facts: {
        args: ["--version"],
        output: CURSOR_CONTRACT_VERSION,
        pattern: "^(\\d{4}\\.\\d{2}\\.\\d{2})-[0-9a-f]+$",
      },
    },
    {
      id: "cursor.argv.flags",
      title:
        "--help lists every flag the launch uses (trust, MCP approval, plugin dir, resume, workspace, force, model)",
      kind: "argv",
      needsModel: false,
      detail:
        "`agent [options] [command] [prompt...]` (commander): the launch is `--trust --approve-mcps --plugin-dir <dir> [--resume=<id> --workspace <dir> | --continue] [-f] [--model <id>] [-- <prompt>]`.",
      facts: {
        usage: "Usage: agent [options] [command] [prompt...]",
        flags: [
          "--trust",
          "--approve-mcps",
          "--plugin-dir <path>",
          "--resume [chatId]",
          "--continue",
          "--workspace <path-or-name>",
          "-f, --force",
          "--model <model>",
          "--list-models",
        ],
      },
    },
    {
      id: "cursor.auth.required",
      title:
        "logged out, -p and --list-models print 'Authentication required'; the TUI asks to log in",
      kind: "command",
      needsModel: false,
      detail:
        "`agent -p <prompt>` and `agent --list-models` both exit 1 with the message; the interactive TUI shows 'Press any key to log in...' and fires no hook. The model list falls back to the configured default and says so.",
      facts: {
        message: "Authentication required",
        printArgs: ["-p", "hi"],
        printExit: 1,
        listArgs: ["--list-models"],
        listExit: 1,
        tui: "Press any key to log in",
      },
    },
    {
      id: "cursor.create-chat",
      title: "create-chat prints a new chat id (a UUID) and then does not exit",
      kind: "command",
      needsModel: false,
      detail:
        "Exists on 2026.11.13 (the probe that decided C5 said otherwise), works keyless, but lingers after printing. Unused: ids are learned from the hooks (C5).",
      facts: {
        args: ["create-chat"],
        pattern:
          "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      },
    },
    {
      id: "cursor.dialogs.skipped",
      title:
        "--trust and --approve-mcps skip the workspace-trust and MCP-approval dialogs",
      kind: "trust",
      needsModel: true,
      detail:
        "Without them a fresh workspace shows 'Workspace Trust Required' and a plugin's MCP server 'MCP Server Approval Required' (both wait for a keypress). With them neither appears; the trust is recorded under Cursor's project dir (`.workspace-trusted`).",
      facts: {
        trustFlag: "--trust",
        trustDialog: "Workspace Trust Required",
        mcpFlag: "--approve-mcps",
        mcpDialog: "MCP Server Approval Required",
      },
    },
    {
      id: "cursor.plugin.layout",
      title:
        "--plugin-dir loads .cursor-plugin/plugin.json, hooks/hooks.json and mcp.json",
      kind: "argv",
      needsModel: true,
      detail:
        "A `hooks.json` at the plugin root is NOT loaded (verified by deleting `hooks/hooks.json`: no hook fired). hooks.json is `{version: 1, hooks: {<event>: [{command, timeout}]}}`; mcp.json `{mcpServers: {<name>: {command, args, env}}}`.",
      facts: {
        flag: "--plugin-dir",
        manifest: ".cursor-plugin/plugin.json",
        hooksFile: "hooks/hooks.json",
        ignoredHooksFile: "hooks.json",
        mcpFile: "mcp.json",
        hooksVersion: 1,
      },
    },
    {
      id: "cursor.hook.command-shell",
      title:
        "hook commands run through a shell with the agent's env and the event JSON on stdin",
      kind: "hook",
      needsModel: true,
      detail:
        "The command string is run by a shell (quoting honored), inherits the agent's env (HARBORMASTER_* identity); stdout is parsed as JSON. Every payload carries these keys (user_email included: recordings redact it).",
      facts: {
        inheritedEnv: "HARBORMASTER_TASK_ID",
        stdinKeys: [
          "conversation_id",
          "generation_id",
          "model",
          "session_id",
          "hook_event_name",
          "cursor_version",
          "workspace_roots",
          "transcript_path",
        ],
      },
    },
    {
      id: "cursor.hook.session-start",
      title: "sessionStart fires when a new chat is created; never on --resume",
      kind: "hook",
      needsModel: true,
      detail:
        "At TUI start (≈4-6 s), or together with beforeSubmitPrompt (either first) when the prompt is on the command line. `session_id` = `conversation_id` = the chat id; `transcript_path` is null (the transcript is written when the first turn ends). A resumed chat fires none.",
      facts: {
        event: "sessionStart",
        hookEventName: "sessionStart",
        transcriptPath: "null",
      },
    },
    {
      id: "cursor.hook.before-submit-prompt",
      title:
        "beforeSubmitPrompt fires on each submitted prompt; additional_context reaches the model",
      kind: "hook",
      needsModel: true,
      detail:
        "Output `{continue: true, additional_context: <text>}`: the model saw the context (undocumented field, verified: it ended its reply with the requested word). Catch-up channel (C4).",
      facts: {
        event: "beforeSubmitPrompt",
        promptKey: "prompt",
        output: { continue: true, additional_context: "<text>" },
      },
    },
    {
      id: "cursor.hook.post-tool-use",
      title:
        "postToolUse fires after each tool; its additional_context is read as tool output and ignored",
      kind: "hook",
      needsModel: true,
      detail:
        "`tool_name` `Shell`, `Read`, … The documented `additional_context` lands inside the tool result, where the model treats it as a prompt injection (it said so and did not comply, also with the Harbormaster header and trust line): no steer. `afterShellExecution` / `afterFileEdit` outputs are not read at all. Harbormaster uses it for the `tool` boundary only.",
      facts: {
        event: "postToolUse",
        toolKey: "tool_name",
        shellTool: "Shell",
      },
    },
    {
      id: "cursor.hook.stop",
      title:
        "stop fires when a turn ends, with its status, loop_count and token counts",
      kind: "hook",
      needsModel: true,
      detail:
        "`status` completed / aborted / error; per-turn (not cumulative) `input_tokens` (incl. cache reads + writes), `output_tokens`, `cache_read_tokens`, `cache_write_tokens`; `transcript_path` set once the transcript exists (null on some resumed turns).",
      facts: {
        event: "stop",
        statuses: ["completed", "aborted", "error"],
        tokenKeys: [
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
        ],
      },
    },
    {
      id: "cursor.hook.stop-followup",
      title:
        "a stop hook's followup_message runs as the next user message, without beforeSubmitPrompt",
      kind: "hook",
      needsModel: true,
      detail:
        "Output `{followup_message: <text>}` is submitted at once; the follow-up turn's stop carries `loop_count` 1 (Cursor caps at 5 per script). Harbormaster hands one only from a `loop_count` 0, completed stop.",
      facts: {
        output: "followup_message",
        loopKey: "loop_count",
        followUpLoop: 1,
      },
    },
    {
      id: "cursor.status.cancel",
      title:
        "Esc fires stop 'aborted', then stop 'error', for the same generation",
      kind: "status",
      needsModel: true,
      detail:
        "Recorded idle (a cancel, not a warning). The cancelled prompt is put back into the input.",
      facts: { key: "\u001b", statuses: ["aborted", "error"] },
    },
    {
      id: "cursor.status.no-pty-status",
      title:
        "nothing on the pty: no OSC 7501, no OSC 9 (the title is the chat's)",
      kind: "status",
      needsModel: true,
      detail:
        "Presence comes from the hooks (C3); the launcher registers the attachment at spawn as working 'Starting…'.",
      facts: { osc7501: false, osc9: false },
    },
    {
      id: "cursor.status.blocked",
      title:
        "a permission prompt fires no hook (open row: blocked is never reported)",
      kind: "status",
      needsModel: true,
      detail:
        "Without -f a shell command outside the allow-list asks in the TUI; no hook reports it, so the row stays 'running'. Launched tasks run with -f; interactive panes are watched by the user.",
      facts: { reported: false },
    },
    {
      id: "cursor.prompt.after-dashdash",
      title:
        "the prompt is a positional after --; a leading '-' and quotes stay text",
      kind: "prompt",
      needsModel: true,
      detail:
        '`-- "-x … it\'s \\"fine\\""` arrived verbatim as beforeSubmitPrompt\'s `prompt`.',
      facts: { separator: "--" },
    },
    {
      id: "cursor.argv.resume",
      title:
        "--resume=<id> --workspace <dir> reopens a chat from any cwd; --continue the newest",
      kind: "argv",
      needsModel: true,
      detail:
        "The chat store is `<config>/chats/<md5(workspace)>/<id>/`; the conversation is shown again ('Loading conversation'), no sessionStart fires.",
      facts: {
        flag: "--resume",
        workspace: "--workspace",
        latest: "--continue",
      },
    },
    {
      id: "cursor.argv.bypass",
      title: "-f runs every command without asking ('Run Everything')",
      kind: "argv",
      needsModel: true,
      detail: "Launched (bypass) tasks get it; interactive panes never (R7).",
      facts: { flag: "-f", label: "Run Everything" },
    },
    {
      id: "cursor.argv.model",
      title: "--model <id> picks the model (ids from --list-models)",
      kind: "argv",
      needsModel: true,
      detail: "Only on a new chat. No thinking flag: effort is part of the id.",
      facts: { flag: "--model" },
    },
    {
      id: "cursor.models.list",
      title:
        "--list-models prints '<id> - <name>' lines; the default is marked",
      kind: "command",
      needsModel: true,
      detail:
        "`Available models`, a blank line, then one line per model; the account's default ends in ` (current, default)`; some names end in zero-width spaces.",
      facts: {
        args: ["--list-models"],
        header: "Available models",
        lines: [
          "auto - Auto (current, default)",
          "gpt-5.3-codex-low - Codex 5.3 Low",
          "claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking",
        ],
      },
    },
    {
      id: "cursor.session-file.layout",
      title:
        "transcript at <data>/projects/<slug>/agent-transcripts/<id>/<id>.jsonl, written when a turn ends",
      kind: "session-file",
      needsModel: true,
      detail:
        "slug = the real workspace path, every run of non-alphanumerics → '-', trimmed. Lines `{role, message: {content}}` and `{type: 'turn_ended'}`: no tokens, no model (usage comes from the stop payloads).",
      facts: {
        dataEnv: "CURSOR_DATA_DIR",
        projects: "projects",
        dir: "agent-transcripts",
        suffix: ".jsonl",
      },
    },
    {
      id: "cursor.input.ready",
      title:
        "text typed before the TUI is ready is dropped; after sessionStart, text then Enter (\\r) submits, a bracketed paste keeps its newlines",
      kind: "prompt",
      needsModel: true,
      detail:
        "C9: the app types only once the agent is at its prompt, which a hooks-reporting harness reaches with sessionStart (or the pty settling on a resume). Ctrl+D twice exits.",
      facts: { enter: "\r", exitKey: "\u0004" },
    },
  ],
);
