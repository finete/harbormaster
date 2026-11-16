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
| 1 | **Trigger**: a **Review** button on the task (beside Await… · Done) plus a "ready to review" hint on a Dev task whose agent is idle with a dirty worktree. The trigger is exposed to the rules engine (facts + events below) so a user can write "idle + dirty → `message "/plannotator-review"`"; **no such rule ships**. Harbormaster never opens a review on its own. |
| 2 | **Placement/focus**: one review tab per task in that task's dockview. The button creates it, or focuses it when present. A rule- or agent-initiated session navigates the existing tab and marks the task; it never steals focus. |
| 3 | **Lifecycle**: the tab persists like a terminal tab; a Plannotator session is its content. When the session ends (feedback sent / server gone) the tab shows a state placeholder ("Review sent — the agent is working on it") with **Review again**. Closing the tab is manual. |
| 4 | **Command**: the harness adapter declares its review command (Pi and Claude Code `/plannotator-review`, Codex `!plannotator review`; none → button disabled). Split button: **Review** (default: the task's PR when it has one, else local changes) · chevron: *Local changes* / *Pull request #N*. No per-task memory. |
| 5 | **Detection UI**: an onboarding line on the agent screen and a persistent per-harness "Code review" row in Settings, re-checked on window focus. Three states: missing → install command, outdated → upgrade command (per piece), ready ✓. Minimums below. |
| 6 | **Generic pane**: the tab type is "agent-opened local URL". Plannotator is wired unconditionally through `PLANNOTATOR_BROWSER`; catching every `BROWSER` open (dev servers, `gh pr view --web`…) sits behind the setting `captureAgentBrowser`, **off by default**, applied per harness by the adapter. Only loopback URLs are shown in-app; anything else goes to the system browser. |
| 7 | **Embedding**: `<iframe>` (verified: Plannotator's review page sets no `X-Frame-Options` / `frame-ancestors`, and its UI never checks `window.top`; sub-resources are sandboxed separately). Sandbox `allow-scripts allow-same-origin allow-forms allow-popups`; CSP `frame-src` for `http://127.0.0.1:* http://localhost:*`. Fall back to `WebContentsView` only if the page misbehaves in a frame. |
| 8 | **Testing**: a fake `plannotator` on PATH for one e2e launch; a contract test pinning the four facts we rely on (below) that runs against a real install and skips otherwise; an opt-in `HARBORMASTER_REAL_PLANNOTATOR=1` full smoke. |

### Minimum versions (from Plannotator's git history)

| Piece | Minimum | Why |
|---|---|---|
| `plannotator` binary | 0.28.0 | "Ask this session" + non-blocking feedback delivered as a session message (#1668/#1672); subsumes the 0.11.1 `PLANNOTATOR_BROWSER` script hook |
| `@plannotator/pi-extension` | 0.28.0 | same, for Pi (#1670); subsumes 0.27.15 |
| Claude plugin `plannotator@plannotator` | 0.28.52 | self-reloading mod (#2356); must match the binary |
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
  → script: `harbormaster open-url "$1" || open "$1"`   (CLI over the local socket; falls back when the app is down)
  → socket op `open_url { url }` (task id from the caller's HARBORMASTER_TASK_ID)
  → core `openTaskUrl` validates loopback, emits `task-url-opened`
  → app: review tab (Plannotator URL) or preview tab (other), per decisions 2/6
Fallback: the pty owner matches `Plannotator session ready: <url>` on the task's
stream and calls the same command, only when the launch env had no handler.
```

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
  source: "plannotator" | "browser";   // plannotator when the URL's server answers the ready-line shape or the caller said so
}
// CoreEventMap gains "task-url-opened": TaskUrlOpenedPayload
```

`contracts/commands.ts`:

```ts
openTaskUrl(input: { taskId: string; url: string; source?: "plannotator" | "browser" }): Promise<void>;
/** Build the adapter's review command for the target (default: pr when the task has one) and deliver it to the session. */
requestReview(input: { taskId: string; target?: "local" | "pr" }): Promise<{ command: string }>;
/** Per-harness Plannotator status (see ReviewSupport). Cheap: version probes, cached 60 s, re-run on demand. */
reviewSupport(options?: { refresh?: boolean }): Promise<ReviewSupport>;
setCaptureAgentBrowser(enabled: boolean): Promise<void>;
```

`contracts/model.ts`:

```ts
export interface ReviewSupportPiece {
  id: "binary" | "pi-extension" | "claude-plugin" | "claude-code";
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
and `worktree.dirty` (boolean, Dev tasks with a worktree; `git status
--porcelain` is cheap) → events `harbormaster.task.agentChanged`,
`harbormaster.task.worktree.dirtyChanged`. The app's "ready to review" hint
reads the same two facts through `getTaskWorkspace` (`dirty`) and presence.

Socket/CLI: op `open_url { url }`; `harbormaster open-url <url>` (task id
from `HARBORMASTER_TASK_ID`; exit 1 with no app, so the script's `|| open`
runs). `harbormaster review [--local|--pr]` is the CLI face of
`requestReview`.

## App

- `resources/bin/harbormaster-open-url` (bundled next to `harbormaster`;
  in dev, `packages/app/scripts/open-url.sh`): `exec harbormaster open-url "$1" || exec open "$1"`.
  Main passes its absolute path as `openUrlHandler` when building launch specs.
- Dockview panel type `url`: iframe per decision 7; a Plannotator URL opens
  as the task's single review tab (`review:<taskId>`), others as preview tabs.
- `TaskActions`: Review split button (decision 4), disabled with a tooltip
  when the harness has no `review` or support is not ready.
- Hint: "Ready to review" chip on the card/row when `agent === "idle"` and
  `worktree.dirty` (Dev only).
- Settings: "Code review" section = `reviewSupport()` rows per harness +
  the `captureAgentBrowser` switch. Onboarding agent screen: one line with
  the same three states.
- Pty fallback: the pane owner greps `Plannotator session ready: ` only when
  the launch had no handler.

## Tests

- core: adapter `review.command` per harness; `openTaskUrl` rejects
  non-loopback; `requestReview` target default; `reviewSupport` with faked
  probes (missing / outdated / ready); snapshot facts + events.
- app: `e2e/plannotator.spec.ts` (one launch) with `e2e/fake-plannotator.ts`
  on PATH: Review button → fake agent receives the command → fake
  Plannotator honours `PLANNOTATOR_BROWSER` → iframe tab shows its page →
  "send" → placeholder with Review again. Settings rows with stubbed
  versions. Proven to fail with the button's handler removed.
- `tests/plannotator-contract.test.ts`: the four facts, against a real
  `plannotator` when on PATH, skipped otherwise.
- `HARBORMASTER_REAL_PLANNOTATOR=1` smoke (opt-in, like the real-CLI smoke).
