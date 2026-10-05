# Harbormaster — architecture rules

Read `docs/design-decisions.md` for the full decision record behind these
rules before proposing structural changes.

- **Core is headless.** `packages/core` owns all board/mover/worktree/presence
  logic behind a command API (commands in, state events out). Frontends
  (Electron app, Pi extension TUI) are replaceable clients: no frontend reads
  or writes state files directly, ever.
- **The API boundary is transportable.** It must stay daemon-ready: no
  Electron, filesystem-layout, or process assumptions leak through it. A
  future remote daemon must be able to implement the same API over a socket
  without changing any frontend.
- **Movers tick only in the app.** Exactly one automation host; the extension
  and TUI never run movers.
- **Agent harnesses are adapters.** Anything Pi-specific (session
  spawn/attach, presence, running-detection) lives behind the harness adapter
  interface in core. Core logic never imports Pi directly. Pi is the only
  adapter today; the interface exists so other agents (Claude Code, Codex, …)
  can be added without touching core logic.
- **The TUI board is frozen.** Keep it compiling against the core API; new
  board features are app-only.
- **UI stack is fixed**: Electron + Vite + React + TypeScript (no Next.js, no
  router), Tailwind + shadcn/ui (copy-in), dnd-kit (kanban board), dockview
  (tabs/splits — a tab and a split are the same panel model), @xterm/xterm +
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
routes to the right account. Everything else on this machine uses the
moshevai/fordefi identity — never copy this repo's git config elsewhere, and
never change this repo's config to the work identity.
