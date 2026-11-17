# In-app code review via Plannotator (design record, 2026-11-14)

Harbormaster has nothing between "agent finished" and the PR page. Rather
than build a diff viewer, it integrates [Plannotator](https://github.com/backnotprop/plannotator)
(MIT / Apache-2.0) **as a product, not a fork**: no vendored code, no bundled
binary. Users install Plannotator and its per-agent plugin themselves;
Harbormaster adds the trigger, the pane, detection and the rules surface.
Settled by grilling, one decision at a time.

## Decisions

| # | Decision |
|---|---|
| 1 | **Trigger**: a **Review** button on the task (beside Await… · Done) (a "ready to review" hint on idle Dev tasks with a dirty worktree shipped first and was removed 2026-11-16: idle + uncommitted changes holds for nearly every idle task, so it said nothing and crowded the sidebar row). The trigger is exposed to the rules engine (facts + events below) so a user can write "idle + dirty → `message "/plannotator-review"`"; **no such rule ships**. Harbormaster never opens a review on its own. |
| 2 | **Placement/focus**: one review tab per task in that task's dockview. The button creates it, or focuses it when present. A rule- or agent-initiated session navigates the existing tab; it never steals focus. The tab is the only indication: no sidebar/card mark (revised 2026-11-16: a "review open" chip outlived closed and never-started reviews). |
| 3 | **Lifecycle**: the tab persists like a terminal tab; a Plannotator session is its content. When the session ends (feedback sent / server gone) the tab shows a state placeholder ("Review sent — the agent is working on it") with **Review again**. Closing the tab is manual. |
| 4 | **Command**: the harness adapter declares its review command (Pi and Claude Code `/plannotator-review`, Codex the `$plannotator-review` skill (revised 2026-11-17, docs/harness-additions.md X9; the earlier `!plannotator review` is superseded); none → button disabled). Split button: **Review** (default: the task's PR when it has one, else local changes) · chevron: *Local changes* / *Pull request #N*. No per-task memory. **Delivery** (revised 2026-11-16, see "Transport → Review button"): the button's command is *typed* into the task's primary pty when the agent is at its prompt, queued until the agent's turn ends when it is working, and left to inbox messaging only when the task has no pty of ours. A harness with its own deliver command (Codex: `codex queue`, X5) gets the command that way instead of keystrokes when the agent is at its prompt and its session id is known (pending until its next turn confirms it, typed after 60 s otherwise; before its first prompt Codex has no session id yet, so the command is typed, with a trailing space that closes Codex's skill popup). Rule-driven reviews (`message` action) keep using messaging. |
| 5 | **Detection UI**: the app has no Settings view yet, so the per-harness "Code review" section (`CodeReviewSettings`, self-contained so it can move to a Settings screen later) lives on the setup wizard's own Code review step (after the Agent step), and on Settings → Code review (docs/settings.md); the one-line status for the chosen default agent sits at its top. Re-checked on window focus. Three states: missing → install command, outdated → upgrade command (per piece), ready ✓. Minimums below. |
| 6 | **Generic pane**: the tab type is "agent-opened local URL". Plannotator is wired unconditionally through `PLANNOTATOR_BROWSER`; catching every `BROWSER` open (dev servers, `gh pr view --web`…) sits behind the setting `captureAgentBrowser`, **off by default**, applied per harness by the adapter. Only loopback URLs are shown in-app; anything else goes to the system browser. |
| 7 | **Embedding**: `<iframe>` (verified: Plannotator's review page sets no `X-Frame-Options` / `frame-ancestors`, and its UI never checks `window.top`; sub-resources are sandboxed separately). Sandbox `allow-scripts allow-same-origin allow-forms allow-popups`; CSP `frame-src` for `http://127.0.0.1:* http://localhost:*`. Fall back to `WebContentsView` only if the page misbehaves in a frame. |
| 8 | **Testing**: a fake `plannotator` on PATH for one e2e launch; a contract test pinning the four facts we rely on (below) that runs against a real install and skips otherwise; an opt-in `HARBORMASTER_REAL_PLANNOTATOR=1` full smoke. |

### Minimum versions (from Plannotator's git history)

| Piece | Minimum | Why |
|---|---|---|
| `plannotator` binary | 0.28.0 | "Ask this session" + non-blocking feedback delivered as a session message (#1668/#1672); subsumes the 0.11.1 `PLANNOTATOR_BROWSER` script hook |
| `@plannotator/pi-extension` | 0.28.0 | same, for Pi (#1670); subsumes 0.27.15 |
| Claude plugin `plannotator@plannotator` | 0.28.52 | self-reloading mod (#2356); must match the binary |
| Claude skill `plannotator-review` | present | in Claude Code `/plannotator-review` is a user skill the binary's install script writes to `$CLAUDE_CONFIG_DIR` or `~/.claude`, under `skills/plannotator-review/SKILL.md`, not part of the plugin. Without it Claude answers `Unknown command: /plannotator-review` (observed 2026-11-16 on a machine whose binary, plugin and Claude Code were all current). Fix: the install script |
| Claude Code | 2.1.287, interactive | the mod needs function hooks; older CC falls back to the blocking hook with no Ask |

Fix commands: binary `curl -fsSL https://plannotator.ai/install.sh | bash`;
Pi `pi update npm:@plannotator/pi-extension` (install:
`pi install npm:@plannotator/pi-extension`); Claude
`claude plugin marketplace update plannotator && claude plugin update plannotator@plannotator`
(install: `claude plugin marketplace add backnotprop/plannotator && claude plugin install plannotator@plannotator`).

### What we rely on from Plannotator (the contract test)

1. `plannotator --version` prints a semver.
2. `PLANNOTATOR_BROWSER=<path containing "/">` on macOS runs that path with the session URL as its only argument (both the binary and the Pi extension's own server).
3. Every session prints `Plannotator session ready: <url>` on stderr before opening anything.
4. The review page is frameable (no `X-Frame-Options`, no `frame-ancestors`).

Upstream ask (issue to open): a generic host IPC registry like their
`~/.plannotator/vscode-ipc.json`, so hosts need no env var.

## Transport

```
agent process (env from the adapter)
  PLANNOTATOR_BROWSER=<app>/Contents/Resources/bin/harbormaster-open-url
  [BROWSER=<same>, only when captureAgentBrowser]
  → script: `harbormaster open-url "$1" --source plannotator || open "$1"`   (CLI over the local socket; falls back when the app is down;
            no `--source` when $BROWSER is the script itself, i.e. captureAgentBrowser: it cannot tell the two apart)
  → socket op `open_url { url, source? }` (task id from the caller's HARBORMASTER_TASK_ID)
  → core `openTaskUrl` validates loopback, emits `task-url-opened`
  → app: review tab (Plannotator URL) or preview tab (other), per decisions 2/6
Fallback: the pty owner matches `Plannotator session ready: <url>` on every task
pty's stream and calls the same command, unless it can prove it exported the
handler into THAT pty (it ran the launch spec whose env set PLANNOTATOR_BROWSER).
```

No record = fallback on: a session started before the handler existed, an
agent the user ran by hand in a task's shell pane, a primary that fell back
to a shell. Only a pty we gave the handler is skipped, so a review never
opens twice.

### Review button: how the command reaches the agent

Observed (2026-11-16, live): the button used to record the command as a
user `steer` in the task's inbox. On a Claude Code task it stayed `pending`
forever: Claude's inbox delivery is hooks (PostToolUse / Stop /
UserPromptSubmit), which only fire while it works, and hook text is
context, not a typed slash command. On Pi the steer was claimed ~5 min
later (agent-settled / 60 s backstop), again as text, not a command. The
review tab showed "Starting review…" indefinitely.

A slash command only runs when it is typed at the agent's prompt, and the
app (main) owns every task's primary pty, so main decides per click
(`packages/app/src/main/review-transport.ts`, pure `decideReviewTransport`):

| Task state | Transport | Review tab |
|---|---|---|
| Live primary pty of ours (pane showing or paneless) **and** the agent at its prompt | core `requestReview({ deliver: "none" })` → main writes `<command>`, then `\r` 150 ms later as its own keystroke (a single chunk ending in Enter reads as a paste in TUIs), into the pty via `writeToPrimarySession`; counts as user input | "Starting review…" |
| Live primary pty, agent working or unsure | core `requestReview({ deliver: "message" })` (user steer, as before); main remembers the message id and, on every presence tick, once the agent is at its prompt claims exactly that message (`claimInboxMessages({ messageIds })`) and types it. If the agent's own delivery claimed it first, nothing is typed | "Review will start when the agent finishes its turn." |
| No primary pty of ours | `requestReview({ deliver: "message" })`, inbox delivery only | "Starting review…" |

"At its prompt" (`agentAtPrompt`) uses what presence already knows: the
presence record is the pane's own pid (`corroboration: "record"`, so the
reporter is the agent process itself, not a stale record or a sub-shell),
live, not mid-turn, and its last OSC 7501 state is `idle` / `done` /
`error`. `blocked` (a permission prompt or a question: typing would answer
it) and "no status yet" are unsure: queued, never typed. The button is no
longer disabled mid-turn.

Rejected: for 15 s after typing, main watches the primary pty for the
agent saying it does not know the command (`Unknown command: /<name>`,
matched with escapes and whitespace removed; `createCommandRejectedMatcher`
in `review-transport.ts`). On a match the tab reads "<Agent> doesn't know
/<name>" with the setup and restart hints and **Try again**, and review
support is re-probed. Detection (the skill piece above) disables the
button up front; this catches what detection cannot see, e.g. a session
started before the skill was installed.

Timeout: 60 s after the request (for a queued one, 60 s after the agent
stops working) with no `task-url-opened` for the task, the tab reads "No
review session appeared" with two hints (the agent may not have run
`/plannotator-review`, check its terminal; Plannotator not set up for
<harness>? Settings → Code review) and **Try again** (same target). A failed
request, or a restored review tab with no request, shows the same state.

Known limits: typed text lands after anything the user left half-typed in
the agent's input line (it is never cleared); a queued review whose steer
the agent's own inbox delivery claims first arrives as context, as before.

## Contract (core API)

`contracts/harness.ts`:

```ts
export type ReviewTarget = { kind: "local" } | { kind: "pr"; url: string };
export interface HarnessReviewCapability {
  /** The text to deliver to the session to start a Plannotator review. */
  command(target: ReviewTarget): string;
}
export interface HarnessAdapter {
  …
  /** Absent = this harness cannot start a review (button disabled). */
  readonly review?: HarnessReviewCapability;
}
export interface BuildLaunchSpecInput {
  …
  /** Absolute path of the host's open-url handler; the adapter exports it as PLANNOTATOR_BROWSER. */
  openUrlHandler?: string;
  /** Also export it as BROWSER (config.captureAgentBrowser). */
  captureBrowser?: boolean;
}
```

`contracts/events.ts`:

```ts
export interface TaskUrlOpenedPayload {
  taskId: string;
  url: string;              // loopback only
  source: "plannotator" | "browser";   // plannotator only when the caller says so (the script, the pty ready-line fallback); default browser
}
// CoreEventMap gains "task-url-opened": TaskUrlOpenedPayload
```

`contracts/commands.ts`:

```ts
openTaskUrl(input: { taskId: string; url: string; source?: "plannotator" | "browser" }): Promise<void>;
/**
 * Build the adapter's review command for the target (default: pr when the task has one).
 * deliver "message" (default): record it as a user steer for the inbox; "none": record nothing,
 * return the command (the app types it into the pty; core never writes to a pty).
 */
requestReview(input: { taskId: string; target?: "local" | "pr"; deliver?: "message" | "none" }):
  Promise<{ command: string; delivered: "message" | "none"; messageId?: string }>;
/** messageIds: claim only those (the app claiming a queued Review it is about to type). */
claimInboxMessages(taskId: string, options: { idle: boolean; messageIds?: readonly string[] }): Promise<TaskMessage[]>;
/** Per-harness Plannotator status (see ReviewSupport). Cheap: version probes, cached 60 s, re-run on demand. */
reviewSupport(options?: { refresh?: boolean }): Promise<ReviewSupport>;
setCaptureAgentBrowser(enabled: boolean): Promise<void>;
/** Working tasks' worktree dirtiness from the last refresh pass, by task id (no git per call). */
listWorktreeStatus(): Promise<Record<string, WorktreeStatus>>;   // WorktreeStatus = { dirty: boolean; checkedAt: string }
```

`contracts/model.ts`:

```ts
export interface ReviewSupportPiece {
  id: "binary" | "pi-extension" | "claude-plugin" | "claude-skill" | "claude-code";
  label: string;
  installed?: string;       // semver when found
  minimum: string;
  state: "ready" | "missing" | "outdated";
  fix: string;              // the exact shell command
}
export interface ReviewSupportHarness {
  harness: string;          // adapter id
  state: "ready" | "missing" | "outdated" | "unsupported";
  pieces: ReviewSupportPiece[];
}
export interface ReviewSupport { harnesses: ReviewSupportHarness[]; checkedAt: string }
// GlobalConfig gains captureAgentBrowser: boolean (default false)
```

Rules surface (`harbormaster` source snapshot, per task): facts
`agent` (presence status: `working` | `idle` | `your-move` | `stopped` | …)
and `worktree.dirty` (boolean, Dev tasks with a worktree) → events
`harbormaster.task.agentChanged`, `harbormaster.task.worktree.dirtyChanged`.
`worktree.dirty` comes from one `git status --porcelain` pass per refresh
tick (rules on or off; 6 in flight, 2 s each, a run that fails or times out
keeps the previous value), stored in core and shared by every reader
(`listWorktreeStatus()` serves it without running git).
`getTaskWorkspace().dirty` runs git fresh per call and stays off periodic
paths.

Socket/CLI: op `open_url { url, source? }`; `harbormaster open-url <url> [--source plannotator|browser]` (task id
from `HARBORMASTER_TASK_ID`; exit 1 with no app, so the script's `|| open`
runs). `harbormaster review [--local|--pr]` is the CLI face of
`requestReview`.

## App

- `resources/bin/harbormaster-open-url` (bundled next to `harbormaster`;
  dev uses the same file under `packages/app/resources/bin/`): runs
  `${HARBORMASTER_CLI:-<sibling>/harbormaster} open-url "$1" --source plannotator`, else `open "$1"`
  (no `exec` before the fallback; no `--source` when invoked as `$BROWSER`).
  Main passes its absolute path as `openUrlHandler` when building launch specs.
- Dockview panel type `url`: iframe per decision 7; a Plannotator URL opens
  as the task's single review tab (`review:<taskId>`), others as preview tabs.
- `TaskActions`: Review split button (decision 4), disabled with a tooltip
  when the harness has no `review` or support is not ready (not mid-turn:
  that queues). The button, Review again and Try again all go through
  `startReview` (lib/review.ts) → IPC `core:requestReview` → main's
  `requestReviewFromButton`, which returns `{ command, delivery: "typed" |
  "queued" | "message" }` for the tab's placeholder (`reviewWaitState`).
- Settings: "Code review" section = `reviewSupport()` rows per harness +
  the `captureAgentBrowser` switch. Onboarding agent screen: one line with
  the same three states.
- Pty fallback: the pane owner greps `Plannotator session ready: ` on every
  task pty except one it exported the handler into (see Transport).

## Tests

- core: adapter `review.command` per harness; `openTaskUrl` rejects
  non-loopback; `requestReview` target default, `deliver: "none"` records
  nothing, `claimInboxMessages({ messageIds })`; `reviewSupport` with faked
  probes (missing / outdated / ready); snapshot facts + events.
- app: `e2e/plannotator.spec.ts` (one launch) with `e2e/fake-plannotator.ts`
  on PATH: Review button (fake pi idle) → the command is typed into the
  fake agent's terminal (it logs typed lines and never runs inbox text) → fake
  Plannotator honours `PLANNOTATOR_BROWSER` → iframe tab shows its page →
  "send" → placeholder with Review again. Settings rows with stubbed
  versions. Proven to fail with the button's handler removed, and with the
  pty write disabled (the command then lands in the inbox only).
  Unit: `tests/review-transport.test.ts` (the decision, typing, the queue),
  `tests/review.test.ts` (`reviewWaitState`).
- `tests/plannotator-contract.test.ts`: the four facts, against a real
  `plannotator` when on PATH, skipped otherwise.
- `HARBORMASTER_REAL_PLANNOTATOR=1` smoke (opt-in, like the real-CLI smoke).
