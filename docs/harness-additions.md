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
| P5 | **Fakes replay, never decide**: one `contract.ts` per harness (`packages/app/e2e/contracts/<harness>.ts`) listing every behavior as a row (`id`, description, the exact strings/sequences). The fake implements only rows; the keyless real-CLI test asserts every row it can without a model call against the pinned binary; the real smoke covers the rest. Drift between fake and binary fails on the same row. **Done for Pi and Claude Code**: rows in `packages/app/e2e/contracts/{types,pi,claude-code}.ts` (`needsModel` marks rows T3 cannot check: a model turn or the user's Plannotator install); `fake-pi.ts` / `fake-claude.ts` inline the rows' strings and name each row they replay (`<CONTRACT>.row("<id>")`) or deliberately skip (`notReplayed("<id>", reason)`: the trust dialogs, Pi's prompt argv); `packages/app/tests/fake-contract-coverage.test.ts` fails on a fake referencing an unknown row, a keyless row its fake never mentions, or a keyless row without a T3 `rowIt`; `packages/app/tests/real-cli-smoke.test.ts` has one test per keyless row id (keyless: a fake API key / a `models.json` provider against a local canned Messages-API stub, a logging stand-in for the `harbormaster` CLI and socket) and lists the `needsModel` rows in a skipped block for T4. |
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

### Codex (verified on codex-cli 0.169.0, real pty, 2026-11-17)

| # | Decision | Evidence |
|---|---|---|
| X1 | **Hooks per session**: `codex --enable hooks --dangerously-bypass-hook-trust -c 'hooks.<Event>=[{hooks=[{type="command",command='''<abs harbormaster path> hook …''',timeout=10}]}]'` for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`; the same flags go **before** `resume <id>` / `fork`. Nothing is written to `~/.codex`. | Fired on new and resumed sessions; payload: `session_id`, `turn_id`, `transcript_path` (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`), `cwd`, `model`. cmux's wrapper does the same (`cmux hooks codex inject-args`). |
| X2 | **Hooks reply instantly**: Codex blocks the TUI until a hook returns (cmux saw 35 s hangs). `harbormaster hook` for Codex captures stdin, replies `{}` (or the decision) within milliseconds and does any socket work in the background. | cmux wrapper comments. |
| X3 | **Session id is learned**, never pre-assigned: `SessionStart` reports it; core binds the task to it (`recordTaskSession`). `expectedSessionFile` is the transcript path from the payload. | No `--session-id` on Codex. |
| X4 | **Presence from 7501 alone**: Codex emits without a probe, including `done`. Quirks: startup `idle→working→idle` blip; `blocked` carries no message. `-c tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"] -c tui.notification_method="osc9" -c tui.notification_condition="always"` adds `OSC 9;<reply text>` right before `done`, used only for the card's message. Ignore OSC 9 bodies starting with a digit and `;` (progress bars). | Observed `idle, working, idle, working, OSC 9 "OK", done`. |
| X5 | **Delivery**: follow-up and idle wake-up (incl. the Review command) via `codex queue --thread <session id> --message <text>`; steer via `PostToolUse` (`additionalContext`); catch-up via `UserPromptSubmit`. A queued message is **pending until confirmed** by the next `UserPromptSubmit` hook or a 7501 `working`; on timeout (60 s) fall back to typing into the pty and show the existing "not delivered" state. Keystrokes are never the primary path. `queue` is text only (attachments travel as paths). | `queue` into a live idle session ran a turn. Known upstream limits: exit 0 = stored; an interrupted-then-resumed session may hold queued items (#56914). |
| X6 | **MCP per session**: `-c mcp_servers.harbormaster.command="node" -c mcp_servers.harbormaster.args=[…]` (or the bundled binary). | Shows `enabled` in `codex mcp list`. |
| X7 | **Permissions**: `--dangerously-bypass-approvals-and-sandbox` for bypass launches; default otherwise (R7). |
| X8 | **Folder trust**: fresh worktrees show "Trust this folder?" (Enter = trust). `-c 'projects."<path>".trust_level="trusted"'` does **not** suppress it. The user answers in the pane (as for Claude); Codex writes `[projects."<path>"]` into `~/.codex/config.toml` itself. `trustPrompt: true`; the real smoke answers it. |
| X9 | **Review**: Plannotator's `$plannotator-review` skill under `~/.codex/skills` (installed by Plannotator's install script); detection piece `codex-skill`. Delivered via X5. `docs/plannotator.md` #4 (`!plannotator review`) is superseded. |
| X10 | **Versions**: `minVersion 0.166.0` (`queue --resume`, 7501 `done`, stable hooks), `verifiedVersion 0.169.0`. Doctor must flag a PATH entry that is only a terminal-multiplexer shim (cmux writes one for `codex` and `claude`). |
| X11 | **Usage**: per-model tokens from the rollout JSONL (new access `codex-session-usage-access.ts`). |

### Cursor (verified on cursor-agent 2026.11.13, real pty, logged in, 2026-11-17)

| # | Decision | Evidence |
|---|---|---|
| C1 | **Full adapter now** (not the shallow custom-CLI tier): the probe removed the uncertainty. Launch: `agent --trust --approve-mcps --plugin-dir <per-session plugin dir> [--resume=<id> --workspace <dir>] [-f] [--model …] [-- <prompt>]`. | Both dialogs ("Workspace Trust Required", "MCP Server Approval Required") are skipped interactively by those flags. |
| C2 | **Per-session plugin dir** under the state dir (`<stateDir>/cursor-plugins/<taskId>/`): `.cursor-plugin/plugin.json` (`{ "name": "harbormaster", … }`), `hooks/hooks.json` (`{"version":1,"hooks":{"sessionStart":[{"command":…}],"beforeSubmitPrompt":[…],"stop":[…],"afterShellExecution":[…]}}`), `mcp.json` (`{"mcpServers":{"harbormaster":{…}}}`). Nothing is written into the worktree or `~/.cursor`. | Hooks fired and our MCP server spawned from the plugin dir; `git status` in the worktree stayed clean. (awslabs/cli-agent-orchestrator uses the same flags since v2026.06.15.) |
| C3 | **Presence from hooks** (no 7501, no OSC 9, title = chat title): `beforeSubmitPrompt` → working, `stop` → done (`status: completed`) / error (`aborted`/`error`), via `harbormaster hook --report`. Declared limitations: stale on a hung hook (pid liveness still ends it); `blocked` on a permission prompt is an open contract row. | Payloads observed. |
| C4 | **Delivery**: follow-up via `stop` returning `{"followup_message": …}` (Cursor submits it as the next user message; `loop_count` guards loops); catch-up via `beforeSubmitPrompt`; steer mid-turn via `afterShellExecution`/`afterFileEdit` is an **open contract row** until the real-CLI tier proves a hook output can inject context. Idle wake-up: typing into the pty (the Review transport), since no `queue` equivalent exists. | `followup_message` verified: a second turn ran. |
| C5 | **Session id is learned** from `sessionStart` (`conversation_id` = `session_id`); `create-chat` does not exist. Resume: `--resume=<id> --workspace <worktree>` works from another cwd. Transcript: `~/.cursor/projects/<cwd slug>/agent-transcripts/<id>/<id>.jsonl`; usage from the `stop` payload (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`) and the transcript. |
| C6 | **Binary aliases**, in order: `agent` (current), `cursor-agent` (legacy symlink), `cursor agent` (the IDE's CLI subcommand). `agent` is a generic name: verify with `--version` output before trusting it. |
| C7 | **Review**: none (Plannotator has no Cursor CLI command). `review` absent → button disabled with "Plannotator doesn't support Cursor CLI yet"; Settings → Code review shows the same. |
| C8 | **Versions**: `minVersion 2026.06.15` (first with `--plugin-dir`), `verifiedVersion 2026.11.13`. |
| C9 | **Input timing quirk**: text typed before the TUI is ready is dropped; the Review/typing transport waits for the first `sessionStart` hook before typing. |

## Test tiers (what each proves, what it cannot)

| Tier | File(s) | Proves | Cannot see |
|---|---|---|---|
| T1 contract (pure + fake exec) | `packages/core/tests/harness-contract.test.ts` | launch-spec shape per `SessionLaunch` mode, env markers, prompt defusing, capabilities consistent with the spec, descriptor completeness | anything the real CLI does |
| T2 fake-CLI e2e | `packages/app/e2e/fake-<harness>.ts` + `<harness>-sessions.spec.ts`, rows from `contracts/<harness>.ts` | app wiring: dropdown, pty argv/env, hook JSON, inbox delivery into the pane, resume/fork ids | whether the rows are true |
| T3 keyless real-CLI (CI, every push) | `packages/app/tests/real-cli-smoke.test.ts` | flags accepted by the pinned binary, 7501 probe/report, hooks fire with our JSON, MCP config loads, trust prompt text, every contract row that needs no model call (canned stub turns drive hooks, transcripts, session files) | real model turns, background work, review |
| T4 real smoke (login, local, release gate) | `packages/app/e2e/real-smoke.spec.ts` | Setup/doctor reads ready, Review opens Plannotator, a message reaches an idle and a busy task, S4 presence scenario, refresh through real `gh` | — |

## Adding a harness: the ordered steps (also `docs/adding-a-harness.md`)

1. Pin the CLI; fill the **capability sheet** from `--help` and a hand-run pty probe (the recording script): session flags, 7501 dialect per scenario, delivery channels and whether each works when idle, MCP injection, permission flag, trust prompts, session-file layout, usage format, review integration, binary aliases, detached child processes it leaves behind.
2. Record every deviation from the standard path here as a decision row.
3. Adapter + descriptor + capabilities + usage reader; `interpretProgramStatus` with the recorded quirks.
4. `contracts/<harness>.ts` rows; `fake-<harness>.ts` replaying them; `<harness>-sessions.spec.ts`; T3 assertions per row; dialect fixtures.
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
