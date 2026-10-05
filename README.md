# Harbormaster

A kanban harbor for coding-agent tasks. Every task gets a berth: its own git
worktree, branch, agent session, and pane. The board assigns berths, shows what
is in harbor, at sea, or delivered, and moves cards as PRs get reviewed,
merged, and deployed.

Harbormaster is the standalone successor to the pi-home Pi extension: the same
headless core (board state, movers, stage hooks, worktree lifecycle, presence)
re-homed behind a desktop app with a real kanban UI and embedded terminal
panes, instead of a TUI inside a cmux workspace.

## Layout

| Package | Role |
|---|---|
| `packages/core` | Headless brain: board/mover/worktree/presence logic behind a command API (commands in, state events out). No UI, no Electron, transport-ready. |
| `packages/app` | Electron desktop app: kanban board (React + Tailwind + shadcn/ui + dnd-kit), dockview tabs/splits, xterm + node-pty session panes. The only mover host. |
| `packages/extension` | Slim Pi extension: `/totask` / `/totemptask` adoption, temp write-guard, and the frozen TUI board as emergency/SSH fallback. |

## Status

Pre-alpha. See `docs/design-decisions.md` for the full design record and
`AGENTS.md` for the architecture rules.
