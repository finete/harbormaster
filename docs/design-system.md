# Harbormaster design system: "brand accent on precision dark"

Decided 2026-11-12 (option B of three rendered candidates). The look the
developer-tool world converged on (Linear, Raycast, Resend, Vercel, Cursor,
Zed): near-black ground, hairline 1px borders instead of shadows, a grey
type ramp, **color withheld from the chrome and spent on exactly two
things**: the one brand accent for actions, and semantic status.

## Tokens (`packages/app/src/renderer/src/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--background` | `#0a0b0c` (hsl 210 8% 4%) | window ground |
| `--card` / `--popover` | `#121415` (hsl 200 8% 8%) | surfaces: cards, panes, header bars, inputs |
| `--muted` | `#171a1c` (hsl 200 10% 10%) | chips, secondary buttons, tab strip |
| `--accent` | `#1c2023` (hsl 200 11% 12%) | hover fill |
| `--border` / `--input` | `#222527` (hsl 204 7% 14%) | every hairline, 1px, never thicker |
| `--foreground` | `#f2f4f5` | primary text |
| `--muted-foreground` | `#8b949e` | secondary text, labels, icons at rest |
| `--primary` | `#6ef5d6` (hsl 166 87% 70%) | **the brand mint from the lighthouse icon**: primary buttons, focused input border, active tab underline, selected row border, links on hover |
| `--primary-foreground` | `#06231d` | text on mint |
| `--ring` | `--primary` at 60% | focus rings |
| `--radius` | `0.5rem` (8px) | buttons, inputs, cards; chips use full pill radius only in the composer chip row |
| status: needs-you | `#ffc34d` (amber, matches the icon's lamp) | "your move", asked, blocked; never for buttons |
| status: ok | `#6ef5d6` at 20% fill / 50% stroke, mint text | PR open/approved pills, "done, wants a look" |
| status: error | `#f0636b` | errors, failed launches, destructive buttons |
| status: info / neutral | `--muted-foreground` | idle, "running" uses a spinner, not a color |

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
- **Tabs / tab strip** (terminal tabs): strip `bg-muted`; the active tab
  `bg-card` with a 2px **mint** bottom edge; inactive `text-muted-foreground`.
  The close × is a ghost icon button that appears on hover/active.
- **Header bars** (Terminals / History / Open in / Await / Done / + terminal):
  one `bg-card` bar with a hairline bottom; left: section label
  (`text-[11px] font-semibold tracking-wider uppercase text-muted-foreground`)
  plus ghost text buttons; right: `secondary` buttons at `sm`, 8px gaps,
  keyboard hints as `<Kbd>`. No `outline` buttons here.
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
- **Motion**: 120ms ease-out on hover/fill changes only; no springs, no
  glows, no gradients anywhere.

## What stays as is

The board (`Board.tsx`, `TaskCard.tsx`) already matches: keep its layout,
only swap colors to the tokens (selected card border → mint, group header
text → mint, PR pills → status ok, "running" spinner → muted).
