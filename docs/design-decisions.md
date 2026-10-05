# Harbormaster: design decision record

Product re-platforming of pi-home (Pi extension + cmux workflow) into a
standalone desktop app. Decisions reached in a grilled design interview,
2026-10-05. Amend this file when a decision is revisited; do not silently
diverge.

## Why leave cmux

The board and the sessions lived in two different programs, so neither could
control the other:

- cmux pane metadata (branch/path/PR) is launch-time state; pi-home cannot
  update it when a pane is reused for a different task.
- "Click a card → open in a side pane, or focus the existing one" is
  impossible when the board is a TUI inside one pane and the window manager is
  someone else (open workspace → open pi-home → select task, every time).
- Live status (spinner while an agent runs, PR badge, stage badge) needs a
  reactive UI fed by core state, not a terminal repainting every 30s.

**Root constraint: the board must own the session panes' lifecycle.**

## Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Audience | Personal tool now, open-source product someday. Core headless; UIs are replaceable frontends. |
| 2 | Session surface | Hybrid, structured-primary ambition: pretty UI where possible, real terminal where needed. v1 session panes are Pi TUIs in ptys (full extension fidelity, no feature race with the Pi TUI). |
| 3 | Platform | Desktop (macOS first) now. Remote-daemon someday → core API transportable; no daemon yet. Mobile/web: non-goals. |
| 4 | Ownership | Build and own it. No waiting on upstream maintainers. pi-gui (MIT) is a parts bin (terminal wiring, later the structured timeline), never a base. |
| 5 | Brain placement | Core extracted into `packages/core` behind a command API (commands in, state events out), hosted inside the app process. The boundary becomes the daemon API later. |
| 6 | Extension ↔ app | Shared core library over the per-user state dir; all writes through the command API; no frontend touches state files. Movers tick only in the app. |
| 7 | TUI board | Frozen, not killed: emergency/SSH fallback compiled against the core API. New board features are app-only. |
| 8 | Attachment | Takeover-offer semantics (verified: Pi has no concurrent-attachment protection, append-only JSONL, no locking). `openGuarded` ports from pi-home; the cmux branch becomes "focus the app pane". |
| 9 | Stack | Electron + Vite + React + TS (no Next.js, no router). Verified as the stack coding agents generate most reliably in 2026. |
| 10 | Design system | Tailwind + shadcn/ui (copy-in ownership), dnd-kit for the board (Kibo UI / Georgegriff shadcn kanban as starting blocks; astryx templates as layout reference: Kanban Board, IDE, Work Item Detail, Side Nav). Re-skin anything lifted from pi-gui. |
| 11 | Layout engine | dockview: tabs and splits are one panel model. Two top-level views: workspace (task sidebar + per-task dockview terminal workspaces, the default) and kanban board (the "home" triage screen, full-width, reached via sidebar button / Cmd+B); clicking a card enters the task's workspace. Per-task dockview instances persist across view switches. Drag/split → extra `$SHELL` pty in the same worktree. Built-in layout serialization for restore-on-restart. |
| 12 | Terminals | @xterm/xterm + node-pty (lift pi-gui's `terminal-service.ts` wiring). Pane↔process lifecycle glue is ours. |
| 13 | Multi-agent future | Harness adapter interface in core (spawn / attach / presence / running-detection). Pi is the only adapter v1. |
| 14 | Name | Harbormaster (npm free, no serious collisions). Private repo `finete/harbormaster`, default branch `main`, monorepo. |
| 15 | Internal architecture | Volatility-based layering per `ai/prds/architecture.md` (Manager / Engine / Resource Access / Utility), carried over from pi-home's `src/` layout. Accessor separation and call-chain direction are hard rules; "all rules in Engines" is advisory. |

## Verified facts the design rests on

- Pi RPC mode implements an extension-UI subprotocol: dialogs
  (`select`/`confirm`/`input`/`editor`) request/response, fire-and-forget
  (`notify`/`setStatus`/`setWidget`/`setTitle`); `custom()` and
  footer/header/editor overrides are TUI-only (`docs/rpc-extension-ui.md`).
- pi-home used `ctx.ui.custom()` in exactly one place (the kanban board
  component), which is replaced by the native board. All other ~70 call sites
  are dialog/notify/status/widget calls that survive outside the TUI.
- pi-gui (minghinmatthewlam/pi-gui, MIT, ~64k LOC) fully renders the dialog
  subprotocol natively, flags terminal-only capabilities gracefully, drives
  sessions through `@earendil-works/pi-coding-agent` with Pi's JSONL session
  files as source of truth, and ships node-pty/xterm terminal wiring. Fast-
  moving solo project → parts bin, not dependency.
- Paseo bridges Pi dialogs into question permissions but intentionally ignores
  fire-and-forget UI; Pi is one provider among many. Not chosen.
- Pi sessions have no concurrent-attachment protection; pi-home's presence
  system exists because of that, and its semantics carry over.
- shadcn/ui + Tailwind is the dominant 2026 React stack and the default
  output of AI UI generators; shadcn kanban blocks exist (dnd-kit-based).

## v1 scope (switch-your-daily-driver bar)

Board with live badges (presence spinner, PR number+state, stage label) ·
click→open/focus pty pane in the right worktree · split shell pane per task ·
takeover-offer flow · task creation + toreview/todone as buttons · movers
ticking in-app.

**Out of v1:** diff viewer, structured timeline, notifications, themes,
cross-task split layouts, daemon, non-Pi adapters.

## Migration order

1. Port pi-home's core (manager/engines/access layers) into `packages/core`
   behind the command API; the frozen TUI in `packages/extension` is its first
   client (pure refactor, value-neutral).
2. Electron shell: board + pty panes on that API.
3. Run alongside cmux/pi-home until trusted.
4. Delete the cmux integration (`record.cmux`, focus-pane branch, `CMUX_*`
   capture) and retire the old pi-home repo to frozen-extension status.
