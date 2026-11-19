# Adding agent harnesses: Codex, Cursor, and the regime that keeps them honest (decision record, 2026-11-17)

Settled by grilling, one decision at a time, after the Claude Code adapter
shipped with three bugs the suite never saw (below). Read this before touching
`packages/core/src/harness/`, the fakes under `packages/app/e2e/`, the
real-CLI tiers, or the doctor/onboarding agent checks. It extends
`docs/release-plan.md` ("Agents (harnesses)", R2/R6/R7/R8/R15) and is the
self-sufficient brief for the implementation workers.

## Why: what the Claude Code adapter taught us

| Symptom | Root cause | Which layer stopped short |
|---|---|---|
| "I have claude, why not found?" (`ce33eca`) | `claude` on PATH was a cmux shim; a Dock-launched app lacks `~/.local/bin` | Detection was never run in the app's real environment |
| Review button did nothing, suite green (`f27e209`) | `fake-pi` treated `/plannotator-review` as a working command; Claude needs a separate skill | **The fake encoded the belief being tested** |
| Review request "pending" forever (`186143b`) | Hooks only fire mid-turn; an idle Claude never receives a steer | Capability model had no "delivers when idle?" dimension |
| Spinner forever on a port-forward (`96c2985`) | Claude reports 7501 `working` + "1 shell still running" after its turn, at its prompt | We mapped the 7501 **spec** 1:1; Claude's **dialect** differs; no test holds Claude's real sequences |
| Folder-trust dialog, orphaned `plannotator review` processes | Only visible with the real tools | Only the opt-in real smoke runs real tools |
| A message to an idle Claude pane waited forever | Every Claude hook needs a turn; the waker skips live panes. Now `channels.wakeIdle: "pty typing"` like Cursor | **The e2e itself sent the fake its `stop`**, acting out the turn a real idle Claude never takes; the real smoke had no cross-agent case |
| A launched child sat idle with no prompt | Its background pi was SIGKILLed before writing a session; the pane resumed the empty id and the prompt was marked delivered. Now a prompt-carrying background launch that exits within the early-exit window calls `releaseInitialPrompt` (refused once a session file exists), and the next launch starts a fresh session with the prompt | The fake pi never dies; the real smoke ran the workspace's pinned dev `pi` (`node_modules/.bin` first on `npx`'s PATH), not the user's. Root cause found later: SentinelOne kills interpreter + script launches with any 943+ char argument, so the retry died too (0.6.1 left a dead pane). Now long prompts travel as a file (`LaunchSpec.promptFile`), the launcher refuses 900+ char arguments, and the fake pi enforces the 943 rule |

Two patterns: fakes derived from assumptions instead of recordings, and
harness knowledge scattered across ~12 files outside the adapter (two
`BUILTIN_AGENT_IDS` lists, label maps in `Onboarding.tsx` and
`CodeReviewSettings.tsx`, `local-onboarding-probe-access`,
`local-environment-probe-access.commands()`, `doctor-runtime` `agents.claude`,
`engines/review-support.ts` pieces, `main/index.ts` diagnostics,
`tools/catalog.ts` text). A checklist is needed *because* the registry is not
the source of truth; so the registry becomes the source of truth first.

## Decisions

### Process

| # | Decision |
|---|---|
| P1 | **Order**: step 0 (descriptor refactor) → Codex → Cursor, sequential. Each adapter ends with its real smoke before the next starts, so the checklist is corrected by the Codex pass before Cursor uses it. |
| P2 | **Step 0, registry as source of truth**: every `HarnessAdapter` carries a `descriptor` (stable id, label, **binary aliases** in lookup order, install hint, version args + parser, `minVersion`, `verifiedVersion`, config dir, review-support piece ids). Onboarding, doctor, diagnostics, Settings labels, the tool catalog text and review-support **iterate the registry**; no file outside `harness/` names an agent id. One unit test asserts every registered adapter fills every field and `minVersion <= verifiedVersion`. |
| P3 | **Gate**: `npm run gate` (biome → lint → typecheck → unit → app e2e, zero `uncaughtException`) and `npm run gate:harness` (gate + keyless real-CLI tier + fresh real-smoke marker). GitHub Actions on the public repo (`ubuntu-latest`, free): typecheck + unit + keyless real-CLI on every push, pinned CLIs cached by version. Electron e2e stays local. |
| P4 | **Mandatory real smoke (T4)**: `release/release.sh` runs `HARBORMASTER_REAL_SMOKE=1` for every built-in harness and refuses on failure or missing login. The smoke writes a gitignored `.real-smoke-ok` (commit hash + time); `gate:harness` refuses when the marker is missing or older than the last change under `packages/core/src/harness/` or `packages/app/e2e/fake-*.ts`. |
| P5 | **Fakes replay, never decide**: one `contract.ts` per harness (`packages/app/e2e/contracts/<harness>.ts`) listing every behavior as a row (`id`, description, the exact strings/sequences). The fake implements only rows; the keyless real-CLI test asserts every row it can without a model call against the pinned binary; the real smoke covers the rest. Drift between fake and binary fails on the same row. **Done for Pi, Claude Code, Codex and Cursor**: rows in `packages/app/e2e/contracts/{types,pi,claude-code,codex,cursor}.ts` (`needsModel` marks rows T3 cannot check: a model turn or the user's Plannotator install); `fake-pi.ts` / `fake-claude.ts` inline the rows' strings and name each row they replay (`<CONTRACT>.row("<id>")`) or deliberately skip (`notReplayed("<id>", reason)`: the trust dialogs, Pi's prompt argv); `packages/app/tests/fake-contract-coverage.test.ts` fails on a fake referencing an unknown row, a keyless row its fake never mentions, or a keyless row without a T3 `rowIt`; `packages/app/tests/real-cli-smoke.test.ts` has one test per keyless row id (keyless: a fake API key / a `models.json` provider against a local canned Messages-API stub, a logging stand-in for the `harbormaster` CLI and socket) and lists the `needsModel` rows in a skipped block for T4. |
| P6 | **Capabilities as data**: `HarnessCapabilities` on each adapter (`sessionId: "preassign" \| "learned"`, `status: { protocol: "osc7501" \| "hooks" \| "none", probe, states, quirks[] }`, `delivery: { steer, followUp, wakeIdle, channel per kind }`, `trustPrompt`, `review`), read by the contract suite and by core's refusal logic. Plus `docs/adding-a-harness.md`: the ordered steps. |
| P7 | **Version floors** (same mechanism as Plannotator's `MIN_VERSIONS`): doctor and onboarding check each built-in agent against `minVersion` (below → fail for the default agent, warn otherwise, with the harness's own upgrade command) and `verifiedVersion` (above → info "newer than tested"). A pin bump = run the real-CLI tier on the new version, re-record the dialect fixtures, update `verifiedVersion`. |

### Status dialect (from `96c2985`)

| # | Decision |
|---|---|
| S1 | Each harness's 7501/OSC 9 behavior is **recorded from the real pinned binary** for a fixed scenario list: startup, plain turn, turn with a tool, permission prompt, Esc cancel, **turn ending with background work**, subagent, compaction, exit. Fixtures live under `packages/core/tests/fixtures/status/<harness>/<version>/<scenario>.txt` (raw bytes), captured by `scripts/record-harness-status.mjs` (a pty runner that answers the 7501 probe; needs a login and a few tokens). |
| S2 | `interpretProgramStatus` unit tests replay the fixtures, so Claude's real "1 shell still running" string is in a test; a pin bump re-records and the diff is reviewed. |
| S3 | Every adapter declares `status.quirks` explicitly, even `[]` (Pi). |
| S4 | T4 gets a presence scenario per harness: "run `sleep 120` in the background, then reply" → the row must show idle / your move, never running. |
| S5 | Claude follow-up fix: the per-session `Stop` hook is a wording-independent "turn over" signal; `Stop` without a later `UserPromptSubmit`/`PostToolUse` overrides a lingering 7501 `working`. The regex stays as the fast path. |

Status-dialect notes (wave 2, claude-dialect lane):

- **Recording (S1)**: `npm run build -w @harbormaster/core`, then
  `node scripts/record-harness-status.mjs --harness <claude-code|pi> --scenario <id>|all [--version <x>]`
  (scenario ids: `startup`, `turn`, `turn-tool`, `permission`, `cancel`,
  `background-work`, `subagent`, `exit`; compaction is not scripted). It
  builds the adapter's own launch spec, skips cmux shims on PATH, runs in a
  throwaway git repo, answers the probe with `ProgramStatusParser`'s reply
  (as `ptySessions.ts` does), answers Claude's folder-trust dialog, kills
  the process and anything left in the repo (`sleep 120`), and writes
  `<scenario>.txt` (raw bytes, ≤ 200 KB) + `<scenario>.json` (`prompts`,
  parsed `reports` with timings, `notes`, and the reviewed `expected`
  state sequence). Recorded: `claude-code/2.1.326/` all eight scripted
  scenarios; `pi/1.5.2/` startup, turn, turn-tool, cancel,
  background-work, exit (Pi has no permission prompts; subagent n/a;
  re-recorded on the 1.5.2 pin 2026-11-19, the same state sequences as
  1.3.0's). Every built-in harness also has `long-output` (2026-11-19):
  a 300-line reply, then scrolling, untruncated up to 1.5 MB, for the pty
  data path rather than the dialect. Pi's is ~950 KB with no newline at
  all (fullscreen, cursor-addressed redraws); Codex's and Cursor's TUIs
  redraw in place too, Claude's prints lines. `packages/app/tests/
  pty-path-replay.test.ts` replays it through the app's real pty pipeline
  and requires linear cost (the 2026-11-19 output-tail bug fails it).
  Claude's `permission` scenario adds `--settings {"permissions":{"ask":["Write","Edit","Bash"]}}`
  because a user allow-list otherwise suppresses the prompt (recorded in
  the .json's `command`).
- **Replay (S2)**: `packages/core/tests/status-dialect.test.ts` feeds every
  fixture through the parser (whole and in 7-byte chunks) and the adapter,
  asserts the .json's reports and `expected` states, and that Claude's
  real `working` "1 shell still running" matches `CLAUDE_AWAITED_BACKGROUND`
  (the `96c2985` regex) and is recorded idle. Pi's background-work ends in
  `done` by itself.
- **Quirks (S3)**: each Claude quirk names its fixture (`[fixture: <scenario>]`)
  or says `[unrecorded]`; `harness-contract.test.ts` asserts the named
  fixture exists. Observed on 2.1.326: trust dialog = `blocked`
  (permission, "trust this folder"); Esc cancel ends `idle`, not `done`;
  `/exit` blips `working→idle`; background work = `working` +
  "<n> … still running". The earlier "done twice / done→working flicker"
  did not reproduce (`[unrecorded]`). Pi 1.3.0: spec sequence, `[]`.
- **Stop-hook override (S5)**: `harbormaster hook inbox --mode …` also
  reports `turn_boundary` (an op over the CLI socket →
  `CoreCommands.reportTurnBoundary`): PostToolUse = `tool`,
  UserPromptSubmit = `prompt`, Stop = `stop` (or `prompt` when the hook
  handed Claude a follow-up, which keeps the turn going). Core
  (`harness/turn-boundary.ts`, `CoreManager.reportPresence` /
  `reportTurnBoundary`) records a `working` as `idle` (message kept) while
  the last boundary of the same process is `stop`, in either arrival order;
  a later `prompt`/`tool` restores `working`. Boundaries are in-memory per
  task and reset on a new pid / `endPresence`. Pi sends none.

### Codex (verified on codex-cli 0.169.0, real pty, 2026-11-17)

| # | Decision | Evidence |
|---|---|---|
| X1 | **Hooks per session**: `codex --enable hooks --dangerously-bypass-hook-trust -c 'hooks.<Event>=[{hooks=[{type="command",command='''<abs harbormaster path> hook codex --event <event>''',timeout=10}]}]'` for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`; the same flags go **before** `resume <id>` / `fork`. Nothing is written to `~/.codex`. **Done (wave 3)**: `harness/codex-adapter.ts` `codexHookOverrides` (the shell-quoted CLI path inside a TOML `'''` literal, `harness/toml-value.ts`); contract rows `codex.argv.hooks`, `codex.hook.*`. Binary facts: `SessionStart` fires with the **first submitted prompt** of a run (new, resume or fork), not at TUI start; `PostToolUse` reports Codex's `exec_command` as `tool_name: "Bash"`; the hook-trust bypass also runs the user's own not-yet-trusted `~/.codex/hooks.json` hooks (without it Codex shows a "Hooks need review" dialog for them). | Fired on new and resumed sessions; payload: `session_id`, `turn_id`, `transcript_path` (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`), `cwd`, `model`. cmux's wrapper does the same (`cmux hooks codex inject-args`). |
| X2 | **Hooks reply instantly**: Codex blocks the TUI until a hook returns (cmux saw 35 s hangs). `harbormaster hook` for Codex captures stdin, replies `{}` (or the decision) within milliseconds and does any socket work in the background. **Done**: `harbormaster hook codex --event …` (packages/cli) reads stdin with a 500 ms cap, prints its reply first (SessionStart/Stop: `{}` at once; UserPromptSubmit/PostToolUse: after the inbox claim), and every socket round trip shares a hard 2 s deadline (`CODEX_HOOK_DEADLINE_MS`), then the process exits; a hung app costs ≤ ~2.5 s (unit test against a socket that never answers). The 10 s "Running hooks" seen in the real smoke came from the user's own hooks, not ours (~0.25 s). | cmux wrapper comments. |
| X3 | **Session id is learned**, never pre-assigned: `SessionStart` reports it; core binds the task to it (`recordTaskSession`). `expectedSessionFile` is the transcript path from the payload. **Done**: op `session_start` (tools/ops.ts) → `recordTaskSession`; `capabilities.sessionId: "learned"` makes `claimSessionLaunch` persist no id for a new/forked launch (the id it returns is a placeholder the adapter never passes; an id without a recorded file counts as one), so the first SessionStart binds. The adapter has no `expectedSessionFile` (the rollout name carries a start timestamp core cannot predict; the hook reports the exact file). Binary facts: the rollout is **written with the first prompt** (named after the start time), so an idle, never-prompted session has neither file nor id; resume/fork take an id, never a path (`open` resumes the id in the rollout's name; `continue` = `resume --last`, the newest session for the cwd). | No `--session-id` on Codex. |
| X4 | **Presence from 7501 alone**: Codex emits without a probe, including `done`. Quirks: startup `idle→working→idle` blip; `blocked` carries no message. `-c tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"] -c tui.notification_method="osc9" -c tui.notification_condition="always"` adds `OSC 9;<reply text>` right before `done`, used only for the card's message. Ignore OSC 9 bodies starting with a digit and `;` (progress bars). **Done**: fixtures `tests/fixtures/status/codex/0.169.0/{startup,turn,turn-tool,permission,cancel,background-work,exit}` (no subagent/compaction); the app's pty layer (`main/osc9-notifications.ts`) hands an OSC 9 note to the next message-less `done`. Recorded: the startup blip shows with the user's MCP servers/hooks loading (not with a bare CODEX_HOME); Esc (cancel, or declining a permission) ends `idle`; a turn leaving background work still ends `done`; the trust dialog reports nothing. | Observed `idle, working, idle, working, OSC 9 "OK", done`. |
| X5 | **Delivery**: follow-up and idle wake-up (incl. the Review command) via `codex queue --thread <session id> --message <text>`; steer via `PostToolUse` (`additionalContext`); catch-up via `UserPromptSubmit`. A queued message is **pending until confirmed** by the next `UserPromptSubmit` hook or a 7501 `working`; on timeout (60 s) fall back to typing into the pty and show the existing "not delivered" state. Keystrokes are never the primary path. `queue` is text only (attachments travel as paths). **Done**: `HarnessAdapter.deliverCommand(kind, sessionId, text)` (contract) → `CoreCommands.harnessDeliverCommand(taskId, kind, text)` (only once the id is learned) → main runs it (`main/harness-delivery.ts` + a pass on every presence tick for tasks at their prompt with pending messages). The message stays `pending` in core until a 7501 `working` (main claims it) or the UserPromptSubmit hook claims it; the hook drops a message the prompt already is (`codexContextText`), so it is never repeated as context. After 60 s unconfirmed, main claims and types it once the agent is at its prompt (multi-line text as one bracketed paste); until then it stays pending. Verified: a queued `$skill` runs the skill. | `queue` into a live idle session ran a turn. Known upstream limits: exit 0 = stored; an interrupted-then-resumed session may hold queued items (#56914). |
| X6 | **MCP per session**: `-c mcp_servers.harbormaster.command="node" -c mcp_servers.harbormaster.args=[…]` (or the bundled binary). **Done**: `command`/`args`/`env`/`cwd` from `piMcpServerConfig` (contract row `codex.argv.mcp`; spawned shortly after start). | Shows `enabled` in `codex mcp list`. |
| X7 | **Permissions**: `--dangerously-bypass-approvals-and-sandbox` for bypass launches; default otherwise (R7). **Binary fact**: a resumed session keeps the permission mode it was created with, so a bypass-launched child reopened in an interactive pane still runs in bypass (contract row `codex.argv.bypass`). See X12 for the sandbox's network. |
| X8 | **Folder trust**: fresh worktrees show "Trust this folder?" (Enter = trust). `-c 'projects."<path>".trust_level="trusted"'` does **not** suppress it. The user answers in the pane (as for Claude); Codex writes `[projects."<path>"]` into `~/.codex/config.toml` itself. `trustPrompt: true`; the real smoke answers it. **Binary facts**: asked only in a git repository (a plain folder never asks); the bypass flag does not skip it; for a linked worktree Codex records the main checkout's path (trusting one task trusts its repository's later worktrees). |
| X9 | **Review**: Plannotator's `$plannotator-review` skill under `~/.codex/skills` (installed by Plannotator's install script); detection piece `codex-skill`. Delivered via X5. `docs/plannotator.md` #4 (`!plannotator review`) is superseded. **Binary/machine facts**: Plannotator's install script put the skill in `~/.agents/skills/plannotator-review` on this machine (not `~/.codex/skills`); Codex 0.169.0 reads both, so the `codex-skill` probe checks `$CODEX_HOME/skills` then `~/.agents/skills`. A typed bare `$name` + Enter only completes it in Codex's popup; the typing fallback adds a trailing space so Enter submits. |
| X10 | **Versions**: `minVersion 0.166.0` (`queue --resume`, 7501 `done`, stable hooks), `verifiedVersion 0.169.0`. Doctor must flag a PATH entry that is only a terminal-multiplexer shim (cmux writes one for `codex` and `claude`). |
| X11 | **Usage**: per-model tokens from the rollout JSONL (new access `codex-session-usage-access.ts`). **Done**: `token_usage_record` lines (per response, deduped by `response_id`; `input_tokens` includes the cached part → cache read; `output_tokens` includes reasoning), the model from the turn's `turn_context`; records of another `thread_id` skipped; `event_msg`/`token_count` running totals as the fallback for older rollouts. A fork's rollout references the parent's history (`forked_from_id`, `history_mode: "paginated"`) instead of copying it, so it has no prefix to subtract. |
| X12 | **Network in the sandbox** (an R7 deviation, decided 2026-11-17): every Harbormaster Codex launch adds `-c sandbox_workspace_write.network_access=true`; the approvals policy is unchanged. Codex's default `workspace-write` seatbelt sandbox denies even binding a loopback port (`listen(0)` → EPERM), so in an interactive pane `plannotator review` died with "port … already in use" and Review never opened; `gh` and dev servers fail the same way. Pi and Claude Code panes have no such restriction, so this makes Codex consistent with them. A per-repository opt-out (the stricter sandbox) could be added later; no setting yet. | Contract row `codex.sandbox.network` (T3 runs `codex sandbox` with and without it); real smoke: Review opens Plannotator from an interactive Codex pane. |
| X13 | **No startup update dialog** (2026-11-19): every Harbormaster Codex launch adds `-c check_for_update_on_startup=false`. Found while recording fixtures: the pinned 0.169.0 met the 0.170.0 release and opened "Update available" with "1. Update now (runs `npm install -g @openai/codex`)" preselected; the recorder's Enter ran the global install. In an app pane the first typed Enter (the Review button's `$plannotator-review`) would do the same. Upgrades stay the user's: doctor's version floors and the descriptor's `upgradeHint`. The recorder passes the same override. |

Codex lane notes (wave 3, codex-adapter): adapter `harness/codex-adapter.ts`
(registered after Claude Code), access `access/codex-code-access.ts`
(models from `<CODEX_HOME>/models_cache.json`, defaults from the top-level
`model` / `model_reasoning_effort` of `config.toml`, rollout lookup) and
`access/codex-session-usage-access.ts`; review piece `codex-skill`.
Contract table `packages/app/e2e/contracts/codex.ts` (24 rows; `needsModel`:
`codex.status.blocked`, `codex.review.plannotator-skill`), replayed by
`e2e/fake-codex.ts`, driven by `e2e/codex-sessions.spec.ts` (an interactive
pane + Review through `codex queue`; a launched child woken by its parent's
message through `codex queue`; each proven to fail with its feature
reverted). T3 (`tests/real-cli-smoke.test.ts`, "Codex") asserts every
keyless row against the pinned 0.169.0, keyless: a fresh `CODEX_HOME`
whose `config.toml` points a `model_providers` entry at a local canned
Responses-API stub (`startResponsesStub`: text "OK", one `exec_command`
call on a trigger) runs turns, tools, all four hooks, `queue`, skills,
resume/fork and the trust dialog with no login. T4 (`e2e/real-smoke.spec.ts`)
runs the Codex cases with `HARBORMASTER_REAL_SMOKE_CODEX=<codex>` (Setup
ready incl. `codex-skill`, the S4 presence scenario, Review via the queued
skill); without it they are skipped and the marker omits codex. Fixtures:
`node scripts/record-harness-status.mjs --harness codex --scenario all
--command <prefix>/node_modules/.bin/codex` (the recorder now takes
`--command`, answers Codex's trust dialog, skips Codex's hook-review
dialog with Esc, and adds `model_reasoning_effort="low"`, `notify=[]`;
the permission scenario runs `-s read-only -a on-request` because
`approval_policy="untrusted"` is rejected on 0.169.0). Contracts-lane
follow-ups closed here: every adapter's `expectedSessionFile` resolves the
cwd's real path (`utilities/canonical-path.ts`; macOS `/tmp` →
`/private/tmp`), and Claude Code's ~1 s probe deadline is a declared quirk.
Doctor, onboarding and Settings needed no edits (P2).

### Cursor (verified on cursor-agent 2026.11.13, real pty, logged in, 2026-11-17)

| # | Decision | Evidence |
|---|---|---|
| C1 | **Full adapter now** (not the shallow custom-CLI tier): the probe removed the uncertainty. Launch: `agent --trust --approve-mcps --plugin-dir <per-session plugin dir> [--resume=<id> --workspace <dir>] [-f] [--model …] [-- <prompt>]`. **Done (wave 4)**: `harness/cursor-adapter.ts` (registered after Codex). Binary facts: `--` ends option parsing (a prompt starting with "-" and quotes arrive verbatim, verified through beforeSubmitPrompt's `prompt`); `--continue` reopens the newest chat (`continue` mode, and `open` when the path names no id); no thinking flag (effort is part of the model id). | Both dialogs ("Workspace Trust Required", "MCP Server Approval Required") are skipped interactively by those flags. |
| C2 | **Per-session plugin dir** under the state dir (`<stateDir>/cursor-plugins/<taskId>/`): `.cursor-plugin/plugin.json` (`{ "name": "harbormaster", … }`), `hooks/hooks.json` (`{"version":1,"hooks":{"sessionStart":[{"command":…}],"beforeSubmitPrompt":[…],"stop":[…],"afterShellExecution":[…]}}`), `mcp.json` (`{"mcpServers":{"harbormaster":{…}}}`). Nothing is written into the worktree or `~/.cursor`. **Done**: the adapter cannot write files (accessor separation), so `LaunchSpec.prepare` (`{ dir, files }`) carries them and the app's pty launcher writes them right before the spawn (`main/launch-prepare.ts`). Binary facts: only `hooks/hooks.json` loads (a `hooks.json` at the plugin root alone fired nothing); registered events are `sessionStart`, `beforeSubmitPrompt`, `postToolUse` (not `afterShellExecution`: its output is not read, and postToolUse covers every tool) and `stop`, each `{command: "<shell-quoted abs CLI> hook cursor --event <event>", timeout: 10}`; mcp.json's entry is `{command, args: ["mcp"], env}` (Claude's shape). The hooks are inert without `--plugin-dir`, so they never outlive the session; the dir is rewritten on every launch. | Hooks fired and our MCP server spawned from the plugin dir; `git status` in the worktree stayed clean. (awslabs/cli-agent-orchestrator uses the same flags since v2026.06.15.) |
| C3 | **Presence from hooks** (no 7501, no OSC 9, title = chat title): `beforeSubmitPrompt` → working, `stop` → done (`status: completed`) / error (`aborted`/`error`), via `harbormaster hook --report`. Declared limitations: stale on a hung hook (pid liveness still ends it); `blocked` on a permission prompt is an open contract row. **Done**: `capabilities.status.protocol: "hooks"`; the launcher registers the attachment at spawn as `working` "Starting…" (`LaunchSpec.hookStatus`), the CLI reports `hook_presence` (op → `CoreCommands.reportHookPresence`, `harness/hook-presence.ts`), applied only to that live attachment: `start` (sessionStart, or the pty quiet for 2 s on a resume, which fires no sessionStart) → idle only while still starting; `prompt`/`tool` → working; `stop` completed → done. **Deviation**: `aborted` → idle, not error: Esc fires stop `aborted` *then* stop `error` for the same generation, so the `error` right after an `aborted` is dropped and a cancel reads like Claude's and Codex's (no warning); a real `error` stop is `error` ("The agent's turn ended with an error"). A stop that hands over a follow-up reports `prompt` (the follow-up turn fires no beforeSubmitPrompt). **Open row** `cursor.status.blocked`, confirmed in T4: an interactive pane's command approval ("Run this command? Not in allowlist: sleep") fires no hook, so the row reads running until the user answers; launched tasks run with `-f`. Fixtures: `tests/fixtures/status/cursor/2026.11.13/{startup,turn,turn-tool,cancel,background-work,exit}` (hook events as the sequence). Recorded: a backgrounded `sleep 120` keeps the turn running (the agent polls its output with Read until it ends, ~2 min), then stop `completed`: never a lingering working after a stop. | Payloads observed. |
| C4 | **Delivery**: follow-up via `stop` returning `{"followup_message": …}` (Cursor submits it as the next user message; `loop_count` guards loops); catch-up via `beforeSubmitPrompt`; steer mid-turn via `afterShellExecution`/`afterFileEdit` is an **open contract row** until the real-CLI tier proves a hook output can inject context. Idle wake-up: typing into the pty (the Review transport), since no `queue` equivalent exists. **Done**: follow-up from a completed stop with `loop_count` 0 only (all pending messages in one `followup_message`; a follow-up turn's own stop never chains another); catch-up through beforeSubmitPrompt's `additional_context` (undocumented field, verified: the model obeyed it); idle wake-up: `channels.wakeIdle: "pty typing"` (`PTY_TYPING_CHANNEL`), main's delivery pass claims the pending messages and types them (bracketed paste for multi-line, Enter on its own) once the agent is at its prompt. **Steer: no** (`delivery.steer: false`): `afterShellExecution`/`afterFileEdit` outputs are not read at all, and postToolUse's documented `additional_context` reaches the model inside the tool result, where it was treated as a prompt injection and ignored (twice, also with Harbormaster's header and trust line); a steer request falls back to follow-up. | `followup_message` verified: a second turn ran. |
| C5 | **Session id is learned** from `sessionStart` (`conversation_id` = `session_id`); `create-chat` does not exist. Resume: `--resume=<id> --workspace <worktree>` works from another cwd. Transcript: `~/.cursor/projects/<cwd slug>/agent-transcripts/<id>/<id>.jsonl`; usage from the `stop` payload (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`) and the transcript. **Done**, with corrections: `create-chat` **exists** on 2026.11.13 (prints a UUID keyless, then does not exit; unused); `--resume` fires **no** sessionStart, so every hook binds its `conversation_id` (`session_start` op, idempotent) with the payload's `transcript_path` or, while that is null (until the first turn ends), the predicted path; slug = the real workspace path with each **run** of non-alphanumerics → one "-", trimmed (Cursor's `workspace-paths` source; `$CURSOR_DATA_DIR` overrides `~/.cursor`); chats live in `<config>/chats/<md5(workspace)>/<id>/` from creation (resume checks either). Fork: Cursor cannot copy a chat, so a reopened Done task's first launch resumes the previous cycle's chat. The transcript holds **no tokens or model**: usage comes only from the stop payloads (per turn, `input_tokens` includes cache reads + writes), recorded by the stop hook (`turn_usage` op → `CoreCommands.recordTurnUsage` → `access/cursor-session-usage-access.ts`, a per-chat ledger under `<stateDir>/harness-usage/cursor/`) and read back per transcript path. |
| C6 | **Binary aliases**, in order: `agent` (current), `cursor-agent` (legacy symlink), `cursor agent` (the IDE's CLI subcommand). `agent` is a generic name: verify with `--version` output before trusting it. **Done**: `descriptor.versionIdentifies` makes doctor/onboarding skip a hit whose `--version` is not the date form; the launch resolves the alias without spawning (`launchArgv`: `agent` only when it resolves into a `cursor-agent` install, else `cursor-agent`, else `cursor agent`). This machine has only `~/.local/bin/cursor-agent`. |
| C7 | **Review**: none (Plannotator has no Cursor CLI command). `review` absent → button disabled with "Plannotator doesn't support Cursor CLI yet"; Settings → Code review shows the same. **Done** with the generic wording (doctor/onboarding/Settings need no production edits, P2): the button is disabled with "This agent cannot start a code review", Settings lists Cursor as "No review command" / "Cursor cannot start a Plannotator review." |
| C8 | **Versions**: `minVersion 2026.06.15` (first with `--plugin-dir`), `verifiedVersion 2026.11.13`. **Done**: `parseCursorVersion` reads `YYYY.MM.DD` (the `-hash` dropped); the shared numeric comparison already orders date versions (2026.06.15 < 2026.11.13), semver unchanged. |
| C9 | **Input timing quirk**: text typed before the TUI is ready is dropped; the Review/typing transport waits for the first `sessionStart` hook before typing. **Done**: "at its prompt" is false while the attachment is "Starting…"; it ends with sessionStart (new chat) or, on a resume (no sessionStart; text typed during "Loading conversation" was dropped), once the pty has been quiet for 2 s. After that, text then Enter 150 ms later submits; the recorder waits for the session-start hook the same way. |

Cursor lane notes (wave 4, cursor-adapter): adapter `harness/cursor-adapter.ts`,
access `access/cursor-code-access.ts` (model list via `--list-models`
when logged in, else the `cli-config.json` default with a "not logged in"
note; transcript/chat lookup; alias resolution) and
`access/cursor-session-usage-access.ts`; presence rule
`harness/hook-presence.ts`; CLI `harbormaster hook cursor --event
session-start|before-submit-prompt|post-tool-use|stop` (replies at once
under the Codex hook's 2 s deadline). Contract table
`packages/app/e2e/contracts/cursor.ts` (22 rows; keyless:
`cursor.version`, `cursor.argv.flags`, `cursor.auth.required`,
`cursor.create-chat`), replayed by `e2e/fake-cursor.ts`, driven by
`e2e/cursor-sessions.spec.ts` (an interactive pane: plugin dir, presence
from hooks, Review disabled; a launched child: a busy child's follow-up
through the stop hook, an idle child's message typed into the pane; each
proven to fail with its feature reverted). T3 (`real-cli-smoke.test.ts`,
"Cursor") runs the pinned tarball keyless: Cursor refuses everything
without a login ("Authentication required"; `--list-models` and `-p` exit
1, the TUI asks to log in), and a `CURSOR_API_ENDPOINT` stub saw only the
JSON key exchange (`POST /auth/exchange_user_api_key`) before a non-HTTP/1
protocol, so all session rows are `needsModel` (status fixtures + T4). T4
(`real-smoke.spec.ts`) runs the Cursor cases with
`HARBORMASTER_REAL_SMOKE_CURSOR=<cursor-agent>`: Setup finds it with its
version (no review support), a pane reaches idle → done through the hooks,
the S4 background-sleep turn ends at rest (answering Cursor's command
approval like a user), usage is counted from the stop payload, and a
parent's message reaches the busy agent through `followup_message`.
Fixtures: `node scripts/record-harness-status.mjs --harness cursor
--scenario startup,turn,turn-tool,cancel,background-work,exit --command
<cursor-agent>` (tool scenarios with `-f`). Doctor, onboarding and
Settings needed no edits (P2).

## Test tiers (what each proves, what it cannot)

| Tier | File(s) | Proves | Cannot see |
|---|---|---|---|
| T1 contract (pure + fake exec) | `packages/core/tests/harness-contract.test.ts` | launch-spec shape per `SessionLaunch` mode, env markers, prompt defusing, capabilities consistent with the spec, descriptor completeness | anything the real CLI does |
| T2 fake-CLI e2e | `packages/app/e2e/fake-<harness>.ts` + `<harness>-sessions.spec.ts`, rows from `contracts/<harness>.ts` | app wiring: dropdown, pty argv/env, hook JSON, inbox delivery into the pane, resume/fork ids | whether the rows are true |
| T3 keyless real-CLI (CI, every push) | `packages/app/tests/real-cli-smoke.test.ts` | flags accepted by the pinned binary, 7501 probe/report, hooks fire with our JSON, MCP config loads, trust prompt text, every contract row that needs no model call (canned stub turns drive hooks, transcripts, session files) | real model turns, background work, review |
| T4 real smoke (login, local, release gate) | `packages/app/e2e/real-smoke.spec.ts` | Setup/doctor reads ready, Review opens Plannotator, a message reaches an idle and a busy task, S4 presence scenario, refresh through real `gh` | — |

## Fake audit (2026-11-19)

Rule: fakes script Harbormaster's own wiring; how a real CLI behaves comes
from contract rows asserted against the pinned binary or from recordings.
The 28 fake-backed e2e specs were audited against it:

- **The agent fakes** (`fake-pi`, `fake-claude`, `fake-codex`,
  `fake-cursor`) cite their behavior row by row (18-25 rows each, a few
  declared `notReplayed`); `fake-contract-coverage.test.ts` enforces it.
- **Inline stand-ins** in specs (argv/cwd/env loggers, idlers, exits, the
  SentinelOne 943-char kill) only exercise wiring: kept.
- **Fixed**: new-task-flow's inline `pi --list-models` table now comes
  from `writeListModelsPi`, backed by row `pi.command.list-models`
  (T3-asserted on 1.5.2); fake Plannotator's settings cookie is backed by
  contract fact 7 (the real page writes SameSite=Lax cookies); perf-flood
  floods with the recorded Pi `long-output` instead of an invented
  "pi-like" stream (production renderer config, mirror off).
- **Verified, kept**: terminal-tabs' OSC title stand-in (every recorded Pi
  session sets `π - <folder>` through OSC 0).
- **Known gap**: the e2e fake `gh` scripts invent `gh`'s output (`auth
  status` text, `pr list` JSON); `gh` is not a harness, so no contract
  covers it. The real smoke (T4) runs real `gh` before a release.
- **Found by the real-Pi flood**: with xterm's screen-reader mirror on
  (`screenReaderMode`, enabled when Electron reports accessibility
  support), a real Pi flood froze the renderer for 26 s; off, hover p95
  was 17 ms. Export diagnostics records `screenReaderMode` in
  `renderer.json`; whether to change when the mirror turns on is open.
- No spec duplicates another's or a unit test's protection: each covers a
  distinct integration seam, so none was deleted.

## Adding a harness: the ordered steps (also `docs/adding-a-harness.md`)

1. Pin the CLI; fill the **capability sheet** from `--help` and a hand-run pty probe (the recording script): session flags, 7501 dialect per scenario, delivery channels and whether each works when idle, MCP injection, permission flag, trust prompts, session-file layout, usage format, review integration, binary aliases, detached child processes it leaves behind.
2. Record every deviation from the standard path here as a decision row.
3. Adapter + descriptor + capabilities + usage reader; `interpretProgramStatus` with the recorded quirks.
4. `contracts/<harness>.ts` rows; `fake-<harness>.ts` replaying them; `<harness>-sessions.spec.ts`; T3 assertions per row; dialect fixtures and the `long-output` pty-path fixture.
5. T4 scenarios for the harness; run it; commit the marker.
6. Doctor/onboarding/Settings need **no** edits (P2); if they do, the descriptor is missing a field.

## Implementation waves

| Wave | Lane | Scope | Done when |
|---|---|---|---|
| 1 | step0-descriptor | P2, P7, P6 (types + Pi/Claude/custom filled), `docs/adding-a-harness.md` | registry-completeness test green; doctor shows version floors; no agent id outside `harness/` |
| 1 | gate-ci | P3, P4 (scripts, workflow, marker, release.sh) | `npm run gate:harness` works locally; Actions green on a push |
| 2 | claude-dialect | S1–S5 for Pi and Claude (recording script, fixtures, replay tests, Stop-hook override) | fixtures committed with versions; `96c2985` regex covered by a replayed fixture |
| 2 | contracts-fakes | P5 for Pi and Claude: contract tables, fakes reduced to replayers, T3 asserting rows | a deliberately wrong row fails T3 against the real binary |
| 3 | codex-adapter | X1–X11 + its contract table, fake, e2e, T3 rows, T4 scenarios | T3 green on 0.169.0; T4 green on this machine |
| 4 | cursor-adapter | C1–C9 + the same set | T3 green on 2026.11.13; T4 green on this machine |

Workers run on short-lived branches/worktrees as transport (AGENTS.md); the
supervisor merges to `main`. Each lane's PR-sized unit lists which decision
rows it closes.
