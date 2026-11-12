# Harbormaster: first public release plan

Decisions reached in a grilled design interview, 2026-11-11. This file is the
spec every implementation wave works from and the checklist the supervisor
tracks. Amend it when a decision is revisited; do not silently diverge.
`docs/design-decisions.md` holds the standing architecture rules; where the
two disagree, this file wins for the release work and the older file is
amended to match.

## Summary of decisions

| # | Topic | Decision |
|---|---|---|
| R1 | Audience | Public MIT repo `finete/harbormaster`; the build is handed to a few people first. |
| R2 | Agent support | Standard path for every agent (status via OSC 7501, tools via one core catalog exposed as MCP + CLI, session via CLI flags). The only per-agent glue is inbox delivery. Pi and Claude Code are fully supported at release. |
| R3 | Unsupported messaging | An agent without inbox glue refuses sends up front ("this agent does not support messaging"). No pending/half delivery. |
| R4 | Status source | OSC 7501 parsed in the app's pty layer (main process, next to node-pty); reported to core through a command. Core never sees terminal bytes. |
| R5 | Tool transport | The app listens on a local unix socket in the state dir. One tool catalog in core, exposed as an MCP server and as the `harbormaster` CLI; both are thin clients of the socket. No subprocess writes state files directly. |
| R6 | Claude inbox | Hooks passed per session with `--settings`: PostToolUse = steer, Stop (block + reason) = followUp, UserPromptSubmit = catch-up. Nothing written to `~/.claude`. |
| R7 | Permissions | Launched (background) tasks bypass permissions by default; visible and switchable per launch; per-repo override. Interactive panes keep the user's own defaults. |
| R8 | Agent choice | App default → per-repo override → per-task dropdown. Children inherit the parent's agent. Reopen keeps the agent. |
| R9 | Automation | Event → condition → action rules engine (see "Rules engine" below). Mover engine deleted. |
| R12a | Signing | Not now. First item once there are more than a handful of users: Apple Developer ID ($99/yr) under `finete`, flip `identity`/`notarize` in electron-builder.yml, turn on electron-updater. Unsigned builds re-prompt folder access under Documents/Desktop/Downloads after every upgrade. |
| R12 | Build | Apple Silicon only, unsigned, electron-builder zip on GitHub Releases, installed/upgraded only via a Homebrew cask (`finete/homebrew-tap`). In-app banner shows the upgrade command. Pipeline produces `latest-mac.yml` so signing + electron-updater later is a config flip. |
| R13 | First run installs | Pi's one-file inbox extension is auto-installed into Pi's extension dir, no prompt. Nothing else global (`harbormaster` CLI comes from the cask). |
| R14 | Onboarding | Four-screen wizard: code root + repository; default agent (detected); enable GitHub (detects `gh auth`); concepts (columns and verbs, rules, inbox, tasks talking to each other). |
| R15 | Agent tests | Contract suite against fake CLIs + real pinned `pi` and `claude` without API keys on every commit. Real-key e2e later, skipped when the key is absent. |
| R16 | Cleanup | Delete pi-home migration, `/totask` / `/totemptask` adoption, the TUI board. `packages/extension` shrinks to inbox delivery. |
| R17 | License / telemetry | MIT. No telemetry. "Export diagnostics" button zips the logs dir. |
| R18 | Order | A plumbing → C rules engine → B Claude Code → D build + cleanup → E onboarding → hand off. |

## Agents (harnesses)

### Status: OSC 7501

Pi, Claude Code, Codex and Crush emit the Program Status Protocol
(OSC 7501, revision 0.4, https://www.superlogical.com/rex/docs/build/program-status).
States: `idle`, `working`, `blocked` (waiting on the user), `done`, `error`,
with an optional message. Programs send it only after the terminal answers
the probe `ESC ] 7501 ; ? BEL` (Claude Code gives up after ~2 s).

- The app's pty owner answers the probe and parses reports from the byte
  stream (a pure utility, unit-tested with raw byte fixtures), then calls
  core `reportPresence(taskId, { state, message, at })`.
- Core's presence model keeps `runningTurn` / "your move" semantics but is
  fed by 7501 instead of the extension. `blocked` = your move; `working` =
  spinner; `done`/`idle` = idle; `error` = idle with a warning. Pid liveness
  stays as the "ended" signal.
- Pi: set `PI_PROGRAM_STATUS=1` in the launch env so it reports without the
  probe round-trip. Claude Code: answer the probe.
- Interactive-input detection ("the user is typing in this task") comes from
  the app's pty input path, not the agent.

### Tools: one catalog, two faces

Core defines the agent tool catalog once (`report_status`, `launch_task`,
`subtask_status`, `find_tasks`, `send_to_task`, plus `inbox_claim` used by
hooks). Two clients expose it:

- `harbormaster mcp`: an MCP stdio server (per session via `--mcp-config` /
  Pi's MCP config) that forwards every call over the socket.
- `harbormaster <command>`: a CLI with the same verbs for hooks and plain
  shells. Never a hand-rolled subset of the catalog (Orca's lesson).

Caller identity (which task is calling) comes from env vars the launch spec
sets (`HARBORMASTER_TASK_ID`, `HARBORMASTER_SESSION_ID`), never from tool
arguments. A call with the app not running returns "Harbormaster is not
running".

### Sessions

Core assigns session ids. Adapters map `SessionLaunch` modes to flags:
Pi (`--session <id>`, `--resume`, `--fork`), Claude Code (`--session-id`,
`--resume`, `--fork-session`, `--continue`). The `open` mode (file known, id
unknown) goes away with the migration code.

### Per-agent glue: inbox delivery only

- **Pi**: `packages/extension` becomes one file that, on turn boundaries,
  calls `harbormaster inbox claim` (over the socket) and delivers via
  `pi.sendMessage` with the existing header + trust line formatting (that
  formatting moves into core so both agents share it). Auto-installed by
  the app at first run; re-installed when the bundled version is newer.
- **Claude Code**: `buildLaunchSpec` passes
  `--settings '{"hooks":{...}}'` with PostToolUse → `harbormaster hook inbox --mode steer`,
  Stop → `harbormaster hook inbox --mode follow-up`, UserPromptSubmit →
  `harbormaster hook inbox --mode catch-up`. The hook prints the hook JSON
  Claude expects (`additionalContext`, or `decision: block` + `reason`).
  Use the absolute path to the binary; the app's PATH is not the shell's.
- Messaging capabilities per adapter drive core's refusal (R3).

### Launch flags (Claude Code)

`claude --session-id <id> [--model <m>] [--effort <level>] [--dangerously-skip-permissions]
--settings <hooks json> --mcp-config <json> -- <prompt>`. The `--` is
mandatory (`--mcp-config` is variadic). Thinking maps to `--effort`
(`off` omitted, `minimal`→`low`). Fork = `--resume <from> --fork-session
--session-id <new>`. Permission bypass per R7. The adapter never touches
`~/.claude/settings.json`.

### Adapter contract tests (R15)

One shared test file runs every adapter against a fake CLI script that
emits scripted OSC 7501 sequences, calls the inbox hook, and exits. A second
job installs the real pinned CLIs (`@earendil-works/pi-coding-agent`,
`@anthropic-ai/claude-code`) and checks, without a model call: the process
starts with our flags, answers/accepts the 7501 probe, loads the MCP config,
runs the hook. Real-key e2e is skipped when the key is absent.

## Rules engine (event → condition → action)

Replaces `engines/movers/*`, `contracts/addons.ts`, `StageHook` and the
`movers` config. Terminology: **source** produces **events**; a **rule** has
an event filter (`on`), a **condition** (`if`) and **actions** (`do`).

### Events

CloudEvents 1.0 JSON envelope (`specversion`, `id`, `source`, `type`,
`subject`, `time`, `data`). `subject` is `task/<id>` when the event is about
a task, absent otherwise. `source` + `id` dedupes.

### Sources

An addon module exporting a source:

```ts
interface Source {
  id: string;                       // "github"
  interval?: number;                // ms between polls; absent = push only
  snapshot?(ctx): Promise<Snapshot[]>;   // facts per subject; core diffs → events
  subscribe?(emit, ctx): () => void;     // native push (webhooks, sockets)
  settingsSchema?: JSONSchema;      // token, interval, what to watch
}
```

Core persists the last snapshot per source per subject and the cursor,
diffs new snapshots into `<source>.<entity>.<field>Changed` events plus
`<source>.<entity>.appeared` / `.disappeared`, and queues native events
through the same path. Transport is the source's choice. Events are also
re-evaluated as **facts**: the current snapshot is available to conditions
as `facts.<source>`.

Built-in sources (same addon shape, shipped in-app, read-only reference in
`~/.harbormaster/addons/`):

- `github`: per task PR: `reviewDecision`, `headSha`, `merged`, `mergedAt`,
  `mergeCommit`, `closed`, `isDraft`, `checks`, `unresolvedThreads`,
  `lastAuthorActivityAt`, `lastReviewerActivityAt`, `author`, `viewerIsAuthor`.
  Unbound: review requests for the viewer, mentions (opt-in). Auth via `gh`.
- `version-endpoint`: per repository deployment stage: the deployed commit
  from the configured URL (today's `version-endpoint` hook).

### Rules

`~/.harbormaster/rules/rules.yaml` (global, ordered) and
`~/.harbormaster/rules/repos/<repo>.yaml` (present = replaces the global
list for that repository). Validated by a JSON Schema shipped in the repo.

```yaml
rules:
  - id: review-changes-requested
    on: github.pr.reviewDecisionChanged        # exact type or glob (github.pr.*)
    if: task.state == "awaiting" && task.awaiting.kind == "review" && event.data.to == "changes_requested"
    do:
      - action: move
        with: { to: dev }
```

- `if` is CEL (`@marcbachmann/cel-js`). Variables: `event`, `task`
  (MoverTaskView successor: id, state, awaiting, branch, repository, pr incl.
  `role`), `facts`, `repo` (incl. deployment pipeline).
- JS escape hatch: `if: js:./checks.mjs#isHotfix`, `action: js:./actions.mjs#custom`.
- Actions at release: `move` (`to: dev | done | await` with `kind` and
  optional `input`), `inbox` (`title`, `body`, `buttons`), `createTask`
  (`title`, `prompt`, `repository`, `pr`, `role`, `start`), `message` (`text`,
  `mode`). `run` is out.
- Arbitration: per tick, one `move` per task (first matching rule in list
  order wins); every matching `inbox` / `createTask` / `message` runs.
- Rules evaluate only in the app (single automation host). A thrown
  condition or action = no-op plus a warning in the audit log.

### Audit log

Every event and every action (with rule id, file and line, task, outcome)
is appended to `~/.harbormaster/events/` (JSONL, rotated). Shown on the
task ("moved to Dev because …") and via `harbormaster events <task>`.
`harbormaster rules check [--task <id>] [--replay <from>]` runs the
current rules over recorded events and prints what would happen without
executing.

### Reviewer tasks

`Task.pr.role: "author" | "reviewer"`. The new-task form has the label;
the github source defaults it (`viewerIsAuthor` false → reviewer). Reviewer
tasks check out the PR head branch and never push or open a PR. New awaiting
kind `author-response`. Built-in rules:

```yaml
  - id: reviewer-author-activity
    on: github.pr.lastAuthorActivityAtChanged
    if: task.pr.role == "reviewer" && task.state == "awaiting"
    do: [{ action: move, with: { to: dev } }]
  - id: reviewer-pr-closed
    on: github.pr.closedChanged
    if: task.pr.role == "reviewer" && event.data.to == true
    do: [{ action: move, with: { to: done } }]
```

### Built-in rules (replace the two movers)

Ship as `rules.yaml` defaults written on first run: review changes
requested → dev; PR merged while awaiting review → await deploy stage 1 (or
`__production`); version endpoint contains the merge commit → next stage or
done (never force-deletes, per the blessed divergence); reviewer rules above.
Prove parity: record a week of events with the old movers, replay through the
new rules, diff the moves.

### Addons

`~/.harbormaster/addons/<name>/addon.json` (`name`, `version`, `provides`:
sources, awaitingKinds, suggested rules) + `source.mjs`. Loaded at app
start; a broken addon is skipped with a warning and may not shadow a
built-in id. Suggested rules are offered for copy into `rules/` on install,
never active by themselves. No sandbox; documented plainly. npm install
comes later (`harbormaster addons install <pkg>`).

## Inbox

One list of everything that needs a human, in the app and via
`harbormaster inbox`. Design settled 2026-11-11 (grilled; inspiration:
Linear's Priority/Other inbox, Orca's agent dashboard, Superhuman's keys).

- **Placement.** The existing sidebar "Inbox" button (and `Cmd+I`) swaps
  the main area for a full inbox view, exactly like Board does. Sidebar and
  task list stay. The button carries a badge = Priority count. No dock
  badge, no OS notifications, nothing pops up on its own.
- **Two tabs: Priority / Other.** Every item has `priority: boolean`,
  **default true**. Built-in producers: agent asked (OSC 7501 `blocked`
  with its message; live, leaves when the state changes, not dismissable)
  = priority; agent reported (`report_status` outcome + note) = priority;
  message approval (not dismissable) = priority; ready to land = priority;
  launch failed = priority; plain idle "your move" (turn ended, nothing
  reported) = other; task done, wants a look = other; couldn't clean up a
  Done task's worktree (its app-owned cleanup failed 3 times; Retry / Open
  folder / Dismiss) = other. Rule `inbox` actions
  are priority unless the rule sets `priority: false`. Optional CEL
  override in settings (`item.kind`, `item.source`, `item.taskId`,
  `item.repo`, `item.priority`).
- **Layout: list + detail.** List ~380px left, selected item's detail
  right. Row = glyph by kind (amber question = asked, green check =
  reported, blue envelope = approval, purple bolt = rule item, red x =
  launch failed, teal flag = ready to land), title (the item's own text),
  muted context line (task · repo · branch), time since, ONE primary action
  visible on hover/selection; everything else behind `…` and keys.
- **Grouping.** By task, tasks ordered by their newest item; unbound items
  (Slack mentions, review requests) in their own group.
- **Detail pane.** Task items: task header (title, branch, PR), the
  question/report text, the last ~30 terminal lines as static text (xterm
  serialize), Open button. Approvals: sender, route, full text (editable),
  attachments, Approve/Reject at the top. Rule items: the rule's `body`
  (markdown) + source facts (PR title/author/description, Slack text) and
  the rule's buttons. Launch failed: error, launch prompt, Retry. No live
  terminal mirror in v1.
- **Leaving.** Own action; dismiss where allowed (not approvals, not live
  questions); snooze with presets 1 hour / this evening / tomorrow morning /
  next week plus a date picker; "Clear Other" bulk action. Derived items
  (asked, plain idle) are recomputed, not stored; the rest persist in
  `~/.harbormaster/inbox/`.
- **Keys** (inbox view focused): `Cmd+I` go to inbox, `J`/`K`/arrows move,
  `Enter`/`O` open task, `A`/`R` approve/reject, `E` edit then approve,
  `C` create task / review task, `D` mark done or dismiss, `H` snooze,
  `Tab` switch tab, `Esc` back to the previous view. Key hints on hover.
- **Buttons per kind.** Asked: Open. Reported: Open · To Done · Dismiss.
  Approval: Approve · Edit · Reject. Rule item: its buttons (e.g. Create
  review task) · Dismiss · Snooze. Ready to land: Mark Done · Dismiss.
  Launch failed: Open · Retry · Dismiss.

## Build and distribution

- electron-builder: `mac` target `zip` (+ `dmg` optional), `arm64` only,
  unsigned (`identity: null`), `publish: github`, produces `latest-mac.yml`.
- `finete/homebrew-tap` repo with `Casks/harbormaster.rb`
  (`binary` stanza installs the `harbormaster` CLI). Release script bumps
  version + sha256 and pushes the tap.
- In-app banner: version check against GitHub Releases (`http-version-access`
  exists), shows `brew upgrade --cask harbormaster`.
- "Export diagnostics" (settings): zips `<userData>/logs` + a redacted
  `config.json` + `harbormaster rules list` output.
- LICENSE: MIT, `finete`.
- Removed: `migrate-from-pihome`, Beads reading, `/totask` / `/totemptask`,
  the TUI board, `cmux` leftovers. README rewritten around the Homebrew
  install, the four concepts, and "add your agent".

## Onboarding (four screens)

1. Code root + add a repository (detects git repos under the root). Warns
   when the root is inside `~/Documents`, `~/Desktop` or `~/Downloads`
   (unsigned build: folder permission re-prompts) and suggests `~/Code`.
2. Default agent: detected Pi / Claude Code (resolved path and version, or
   the install command when missing). Custom CLIs are configured in
   `config.json` (`agents.custom[]`), not in the wizard.
3. Enable GitHub: detects `gh auth status`; explains it powers card moves
   for your PRs and review tasks for others' PRs. Writes the default rules.
4. Concepts: the three columns and verbs; rules (`~/.harbormaster/rules`);
   the inbox; tasks talking to each other (children, messages, cross-task
   messages land in your inbox for approval).

## Implementation waves and checklist

Supervisor tracks this table. A row is done only when merged to `main`
with the full gate green and the acceptance checked.

| Wave | Item | Acceptance | Status |
|---|---|---|---|
| A | Local socket + tool catalog in core; `harbormaster` CLI + `harbormaster mcp` | Pi session launched by the app can call `report_status`, `launch_task`, `find_tasks`, `send_to_task` through MCP; CLI returns the same; "not running" error when the app is down | merged 88b43c1 |
| A | OSC 7501 parsing in the app pty layer → `reportPresence` | Fake CLI emitting 7501 drives spinner / your move / idle in e2e; probe answered; unit tests on raw bytes | merged 88b43c1 |
| A | Extension shrunk to inbox delivery; presence reporter, commands, widget, tools removed; auto-install at first run | Steer/followUp messages still arrive in a Pi task session; `packages/extension/src` is one module plus tests | merged 88b43c1 (real-pi smoke only; no e2e inside Pi) |
| A | Delete migration, adoption commands, TUI board | Code and scripts gone; README updated | merged 88b43c1 (no /totask or TUI existed anymore) |
| C | Rules engine core: CloudEvents, sources + snapshot diff, CEL, YAML + schema, arbitration, audit log, `rules check`, addon loader | Unit tests; replay parity with the old movers; mover engine deleted | merged 0f68416 (adds a built-in `harbormaster` board source so rules re-evaluate on column changes) |
| C | `github` and `version-endpoint` sources; default `rules.yaml`; reviewer role + `author-response` kind | Existing e2e flows (review → dev, merge → deploy, deploy → done) pass on rules | merged 0f68416 (deploy → done stays a core integration test: https-only version endpoint) |
| C | Inbox view in app (per "Inbox" above) + `harbormaster inbox`; new-task form PR URL + role label; audit shown on task | Review-requested item → "Create review task" creates a reviewer task; asked/reported/approval items in Priority, idle in Other; keys work; e2e | merged |
| B | Claude Code adapter: launch spec, hooks, mcp-config, permissions switch, agent choice (app/repo/task), child inheritance | Contract tests pass; real `claude` smoke without key passes; e2e with fake claude: status + inbox delivery | merged (claude 2.1.322 starts with our flags and probes 7501; report/MCP/trust dialogs unproven without login) |
| B | Agent contract test suite + real-CLI smoke job (pi, claude) | Both jobs green locally and in CI | merged; real-CLI smoke is opt-in `HARBORMASTER_REAL_CLI=1` (no CI yet) |
| D | electron-builder, Homebrew tap + release script, version banner, export diagnostics, LICENSE, README | `brew install --cask finete/tap/harbormaster` works on a clean Mac; banner shows after a release bump | merged 555ccf8; manual: create `finete/homebrew-tap`, first `release/release.sh`, verify brew install on a current-Xcode Mac |
| E | Onboarding wizard (four screens), first-run defaults | e2e: fresh state dir → wizard → first task created | merged |

## Follow-ups logged during merges

- Wave A: `binding.sessionPath` is no longer recorded (the extension was its
  only writer); reopening a Done task without a recorded file starts fresh.
  Follow-up: fork by id (`pi --fork <id>`).
- Wave A: presence liveness is pid-based; sweep records whose pid is not one
  of the app's ptys on startup.
- Wave A: Pi reports `idle` before processing its startup prompt, so a fresh
  launch can briefly not count as working for the launch slot cap.
- Wave A: the real `pi-mcp-adapter` path (`-builtin:mcp`) is untested; the
  user's `~/.pi/agent/settings.json` still lists the old extension package
  path and should drop it (double load is harmless).
- Wave A: `harbormaster hook inbox` exits 0 with `{}` on stdout when the app
  is down (a Stop hook exiting 2 would loop Claude); confirmed by wave B.
- Wave A: AGENTS.md still calls the TUI frozen and the extension a frontend.
- Wave D: `brew audit` / local install blocked by this machine's Xcode 16.4.
- Wave C: rule-sent messages (`MessageSender {kind: "rule"}`) take the
  approval route; decide whether they should bypass approval.
- Wave C: addon awaiting kinds are listed but not registered in the picker
  (`AwaitingKind` is a closed union).
- Wave C: `RulesRuntime.dispose()` is not called on quit.
- Wave C: AGENTS.md / design-decisions "Three verbs" still say "movers".
- Wave C: on first start after merge, a config's `movers` list becomes the
  first `rules.yaml`; every task fires `.appeared` once.
- Wave B: reopening a Done Claude task starts fresh (core forks only from a
  recorded `sessionPath`); fix = fork by id in `claimSessionLaunch` (the
  adapter already maps `fork` to `--resume <from> --fork-session`).
- Wave B: a real first Claude launch may stall on the workspace-trust and
  "Bypass Permissions" one-time dialogs until the pane is opened; check with a
  logged-in claude on the first launched task.
- Wave B: wire the real-CLI smoke into CI (no secrets needed, ~45 s).
- Inbox UI: `harbormaster inbox list` lacks the presence-derived items
  (asked/reported/idle/done/launch-failed/ready-to-land); they are assembled
  in the renderer. Move `assembleInbox` into a core engine fed by
  presence + board so the CLI matches the app.
- Inbox UI: 7501 `error` is filed as an Other "Stopped with an error" item;
  revisit if errors should be Priority.
- Inbox UI: "Retry" on a failed launch bypasses `launch.maxConcurrent`.
- Inbox UI: board drag e2e helpers may share the dnd-kit 50 ms click-guard
  race the sidebar spec had (fixed there with a condition wait).
- Wave E: "Enable GitHub" off disables only the rules `github` source; the
  refresh's PR-status `gh` batch still runs.
- Wave E: agent detection uses the app process PATH (same as launching);
  agents only on the login shell's PATH show "not found".
- Wave E: existing users see the wizard once after upgrading (pre-filled).
- Worker briefs: with the worktree's root `node_modules` symlinked to the
  main checkout, `@harbormaster/core` resolves to main's build; to test core
  changes in the app, replace the symlink with a directory of symlinks that
  points `@harbormaster/*` at the worktree packages.
