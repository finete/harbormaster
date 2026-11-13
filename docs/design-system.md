# Harbormaster design system: "brand accent on neutral grey"

Decided 2026-11-12 (option B of three rendered candidates); ground moved
from near-black to neutral grey on 2026-11-13. The look the developer-tool
world converged on (Linear, Raycast, Resend, Vercel, Cursor, Zed): a dark
neutral-grey ground with no hue tint, hairline 1px borders instead of
shadows, a grey type ramp, **color withheld from the chrome and spent on
exactly two things**: the one brand accent for actions, and semantic status.

The work area (workspace header, tab strip, tabs, terminal panes) is one
unbroken ground; the sidebar and the board sit one step lighter on
`--chrome`.

## Tokens (`packages/app/src/renderer/src/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--background` | `#1e1e1e` (hsl 0 0% 12%) | work area: workspace header, tab strip, tabs, terminal canvas |
| `--chrome` | `#222324` (hsl 210 3% 14%) | sidebar, board ground and board header |
| `--card` / `--popover` | `#2a2b2c` (hsl 210 2% 17%) | surfaces: cards, dialogs, menus, inputs |
| `--muted` | `#303132` (hsl 210 2% 19%) | chips, secondary buttons |
| `--accent` | `#383839` (hsl 210 2% 22%) | hover fill |
| `--border` / `--input` | `#333435` (hsl 210 2% 20%) | every hairline, 1px, never thicker |
| `--foreground` | `#f2f2f2` | primary text |
| `--muted-foreground` | `#999a9c` | secondary text, labels, icons at rest |
| `--primary` | `#9eebd9` (hsl 166 66% 77%) | **the brand mint**, softened to sit at the same pastel level as the working yellow: primary buttons, focused input border, active tab edge, selected row border, links on hover |
| `--primary-foreground` | `#06231d` | text on mint |
| `--ring` | `--primary` at 60% | focus rings |
| `--radius` | `0.5rem` (8px) | buttons, inputs, cards; chips use full pill radius only in the composer chip row |
| status: working | `#ffe066` (pale yellow) | an agent turn is running: the stepped spinner and the "running" badge; never for buttons |
| status: ok | `#9eebd9` at 20% fill / 50% stroke, mint text | "your move" (agent finished, waiting on you), PR open/approved pills, "done, wants a look" |
| status: needs-you | `#ffc34d` (amber, matches the icon's lamp) | blocked, asked, approvals, warnings; never for buttons |
| status: error | `#f0636b` | errors, failed launches, destructive buttons |
| status: info / neutral | `--muted-foreground` | idle, waiting on parent |

Each agent state has one color everywhere: yellow = working, mint = your
move, amber = something is wrong or blocked.

Terminal panes use the same `#1e1e1e` ground, `#ffffff` foreground and the
"Apple System Colors" ANSI palette (Ghostty theme set); cursor and selection
are mint (`lib/terminal-host/options.ts`).

Remove: every hardcoded `sky-*` / `blue-*` / `emerald-*` Tailwind color in
the renderer. Blue is gone from the product; green/teal is only ever the
mint token.

## Components (`components/ui`)

- **Button**: `default` = mint fill, dark text, `hover:bg-primary/90`,
  active `translate-y-px`. `secondary` (new, replaces most `outline` uses) =
  `bg-muted` with a hairline border, text `foreground`, hover `bg-accent`.
  `outline` = transparent with hairline, for rare tertiary. `ghost` =
  no border, `text-muted-foreground`, hover `bg-accent text-foreground`.
  `destructive` = error fill. Sizes: `sm` 28px, default 32px, `lg` 36px.
  Icons 14px at `sm`, 16px otherwise. Keyboard hint inside a button is a
  `<Kbd>`: 20px tall, `bg-foreground/8`, hairline, mono 11px, muted text.
- **Split button** (Start ▾, Open in ▾): one pill, the chevron half
  separated by a 1px line in `primary-foreground/20`, same fill.
- **Segmented control** (Task · Review · Chat; Priority · Other): track =
  `bg-background` with hairline; the selected segment = `bg-muted` with a
  hairline, `font-semibold text-foreground`; others `text-muted-foreground`.
- **Chip** (Repository · arnac): `bg-muted` hairline pill, label in
  `muted-foreground`, value in `foreground` medium; hover `bg-accent`.
- **Input / Textarea**: `bg-card`, hairline, focus = `border-primary` plus
  `ring-1 ring-ring`; placeholder `muted-foreground/70`.
- **Tabs / tab strip** (terminal tabs): strip, tabs and pane share
  `--background`; hairline dividers between tabs. The active tab is marked
  by `foreground` text, its always-visible close ×, and a **mint** edge
  line; inactive tabs `text-muted-foreground`, close × on hover only.
  New shells come from the per-group split buttons or a click on the empty
  strip, not from a header button.
- **Header bars**: the workspace header (History / Open in / Await / Done)
  is `bg-background`, the board header `bg-chrome`, each with a hairline
  bottom; left: optional section label
  (`text-[11px] font-semibold tracking-wider uppercase text-muted-foreground`)
  plus ghost text buttons; right: `secondary` buttons at `sm`, 8px gaps,
  keyboard hints as `<Kbd>`. No `outline` buttons here.
- **Working spinner** (`components/ui/working-spinner.tsx`): a 2px
  `status-working` ring with a transparent top, rotating once per second in
  12 steps (`steps(12)`, transform only, phase-aligned across instances);
  still and closed under reduced motion. Never a smooth infinite animation:
  that redraws the window every vsync.
- **Cards** (board, inbox rows, wizard): `bg-card`, hairline, `radius`;
  selected = `border-primary`; hover = `border-foreground/20`. No shadows.
- **Badges / pills**: status colors above, 12px text, 999px radius, fill at
  12–20% with a 35–50% stroke of the same hue.
- **Popovers / menus**: `bg-popover`, hairline, `radius`, 4px item radius,
  `data-[highlighted]:bg-accent`. Item text 14px, shortcuts in `<Kbd>`.
- **Dialogs / sheets**: `bg-card`, hairline, no backdrop blur; overlay
  `bg-background/70`.
- **Typography**: system UI sans (`-apple-system, Inter, …`) 14px body,
  13px secondary, 11px uppercase section labels; mono (`ui-monospace,
  JetBrains Mono, Menlo`) for branches, paths, PR refs, keys. Titles 18–20px
  semibold; never heavier than 600 except the composer's title field.
- **Motion**: 120ms ease-out on hover/fill changes only, plus the stepped
  working spinner; no springs, no glows, no gradients anywhere.

## What stays as is

The board (`Board.tsx`, `TaskCard.tsx`) already matches: keep its layout,
only swap colors to the tokens (selected card border → mint, group header
text → mint, PR pills → status ok, "running" badge → status working).
