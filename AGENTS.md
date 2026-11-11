# Harbormaster: architecture rules

Read `docs/design-decisions.md` for the full decision record behind these
rules before proposing structural changes, including its "Layering" section
for the volatility-based service layering (Manager / Engine / Resource Access /
Utility) that `packages/core` follows. Pi-home's `src/` layout
(`manager/`, `engines/`, `access/`, `utilities/`, `contracts/`) carries over.

- **Accessor separation is a hard rule.** All storage and external-system I/O
  (state files, git, GitHub, Pi sessions, ptys) lives in `access/` services
  exposing atomic business verbs. Managers and Engines never touch a resource
  directly; frontends never call access services. Call-chain direction
  (Client → Manager → Engine → Access → Resource, utilities callable from any
  layer, never upward) is enforced. Placing every business rule in an Engine
  is advisory, not mandatory; extract one when logic is shared or volatile.

- **Core is headless.** `packages/core` owns all board/rules/worktree/presence
  logic behind a command API (commands in, state events out). Frontends
  (the Electron app, the `harbormaster` CLI/MCP server) are replaceable clients: no frontend reads
  or writes state files directly, ever.
- **The API boundary is transportable.** It must stay daemon-ready: no
  Electron, filesystem-layout, or process assumptions leak through it. A
  future remote daemon must be able to implement the same API over a socket
  without changing any frontend.
- **Rules evaluate only in the app.** Exactly one automation host; the Pi
  extension never runs rules (it only delivers inbox messages).
- **Agent harnesses are adapters.** Anything Pi-specific (session
  spawn/attach, presence, running-detection) lives behind the harness adapter
  interface in core. Core logic never imports Pi directly. Adapters today:
  Pi, Claude Code, and configured custom CLIs; others (Codex, …) are added
  without touching core logic.
- **UI stack is fixed**: Electron + Vite + React + TypeScript (no Next.js, no
  router), Tailwind + shadcn/ui (copy-in), dnd-kit (kanban board), dockview
  (tabs/splits: a tab and a split are the same panel model), @xterm/xterm +
  node-pty (session panes).
- **pi-gui is a parts bin, not a base.** Code lifted from
  minghinmatthewlam/pi-gui (MIT) must be re-skinned to our design tokens and
  attributed. Never adopt its bespoke CSS as a foundation.
- **Attachment safety.** Pi sessions have no concurrent-attachment protection
  (append-only JSONL, no locking). Any surface that opens a session must go
  through the takeover-offer guard (stop-and-attach for headless runs, focus
  the existing app pane, or explicit attach-anyway).

## Identity

This repository belongs to the `finete` GitHub account. Repo-local git config
pins `finete <34818222+finete@users.noreply.github.com>`; the remote embeds
the username (`https://finete@github.com/...`) so gh's credential helper
routes to the right account. Never copy this repo's git config elsewhere, and
never change this repo's config to any other identity.

**Hard user separation:** every git and GitHub operation on this repository,
including push, `gh` API calls, and anything else, must act as `finete` and no other account.
If a `gh` command is ever needed here, prefix it:
`GH_TOKEN="$(gh auth token --user finete)" gh …`. Never add other accounts
as collaborators.

**Workflow:** solo development, directly on `main`, with no pull requests and no
review ceremony. Subagents/implementers work on short-lived local branches or
worktrees purely as transport; the supervisor reviews, merges to `main`, and
pushes. Keep `main` green (typecheck + tests pass at every commit).

## Testing workflow

The e2e suite is slow (full run ~2.5 min); spend it deliberately.

- **Iterate on targeted tests.** While working, run only the specs and unit
  files you touch: `npx playwright test e2e/<spec>.spec.ts` (after
  `npx electron-vite build` if main/preload/renderer changed) and
  `npx vitest run <file>`. Never run the full e2e suite to check one change.
- **Full suite once, at the end.** The complete gate (biome → lint →
  typecheck → `npm test` → `npm test -w @harbormaster/app`, zero
  `uncaughtException` lines) runs once when the work is done. Rerun it only
  after a fix to something it caught.
- **Prove new tests can fail, cheaply.** Each new e2e must be shown to fail
  with its feature reverted — run *only that spec* for the reverted check,
  then restore. A test that passes with the feature broken is worse than none.
- **Keep the suite lean.** No e2e whose protection a unit test or broader e2e
  already provides; one e2e per integration seam; pure logic goes in unit
  tests; merge small same-fixture tests rather than adding launches. Use
  condition waits, not fixed sleeps (a sleep only where "nothing happens"
  is the behavior, with a comment).
- **Leave no app instances behind.** Close every Electron app a test or
  scratch script launches; leaked instances slow every later run.
- **Run headless: the user must never see a test app.** Every e2e or
  scratch launch sets `HARBORMASTER_WINDOW_OFFSCREEN=1`, which makes the
  window invisible (opacity 0, click-through, never focused, no dock icon)
  while it still renders normally for Playwright. Every new spec or script
  that launches the app must set it too. Never start a visible instance
  (`npm run dev`, `electron .`) to check something; use the e2e harness.
