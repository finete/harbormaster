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

## Running a task's terminal pane

A task workspace's first terminal panel runs `pi` (the rest, and any
scratch/unbound task's panels, run a plain `$SHELL`). That pane needs the
presence-reporting extension installed into your `pi` once:

```sh
npm run install-extension
```

(runs `pi install <repo>/packages/extension`). Without it, panes still open
(falling back to a plain shell with a dismissible warning if `pi` itself
isn't on PATH), but presence/running badges have nothing to report.

## Migrating from pi-home

`npm run migrate-from-pihome` one-way-migrates pi-home's tasks (permanent and
temporary, including done/archived work) into Harbormaster's task store.
Task identity/state/titles are read out of pi-home's Beads database (the same
`bd` CLI pi-home itself shells out to); workspace bindings, PR state, and
awaiting context come from pi-home's `state.json`. It is read-only toward
pi-home with exactly one exception: after a successful `--apply` it sets
`automation: false` in pi-home's `config.json` so pi-home's own movers stop
touching migrated tasks (reversible — set it back to `true` by hand).

- Dry run by default; pass `--apply` to actually write.
- Idempotent: already-imported tasks (matched on a stored pi-home id) are
  skipped on re-run.
- Refuses `--apply` if pi-home shows a live session attached to a task
  (close that pane, or pass `--force` once you've confirmed it's fine).
- `npm run migrate-from-pihome -- --help` for all options.

## Status

Pre-alpha. See `docs/design-decisions.md` for the full design record and
`AGENTS.md` for the architecture rules.
