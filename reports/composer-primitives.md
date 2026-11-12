# Composer → design-system primitives

The New task composer now uses the shared `components/ui` primitives
instead of its own hand-rolled ones. No core changes and no new dependencies.
Everything is staged and nothing is committed.

## What changed

1. **Mode toggle (Task · Review · Chat).** `ModeSwitch` is now a thin wrapper
   over `Segmented` at `size="sm"`. The testids are unchanged:
   `new-task-mode`, `new-task-mode-{task,review,chat}`, `role=radio`,
   `aria-checked`. The icons and per-mode hint titles are kept.
   - `Segmented` now adds `data-selected="true|false"` to each segment.
     `new-task-flow.spec.ts` checks it ("Chat is never sticky").
   - `Segmented` now passes extra HTML/`data-*` attributes through to the
     track. The PR role segment uses this for `data-role`.
2. **`DetailChip` removed. The composer uses the shared `Chip`, extended
   instead of keeping a second component:**
   - The value span always carries `data-chip-value` and is
     `shrink-0 whitespace-nowrap`, so it is never ellipsized. The chip is
     `max-w-full overflow-hidden`. The row keeps `flex-wrap`.
   - New props:
     - `valueTestId`: e.g. `new-task-base-ref`.
     - `valueClassName`: the needs-you color when no Where is chosen.
     - `overflowTitle`: the full-value tooltip. It is added only when the
       chip is clipped, checked on pointerenter as
       `scrollWidth > clientWidth`. Otherwise only the hint `title` shows.
     - `readOnly`: renders a `<span data-readonly="true">` with no hover.
       Used for Repository and Base when they come from a PR.
   - Open state is `data-[state=open]:bg-accent`.
   - New `ChipValue` export for extra values. The Options chip uses it for
     `· parent: …` and `· skip prompts: …`, which keep their
     `new-task-parent` / `new-task-options-bypass` testids.
   - Options is now a `Chip` (label "Options", `border-dashed`, chevron).
     It keeps `new-task-options` and `data-bypass`.
   - All testids are kept: `new-task-where` (with `data-where`),
     `new-task-base`, `new-task-base-ref`, `new-task-agent` (with
     `data-harness`), `new-task-model` (with `data-model`),
     `new-task-thinking` (with `data-thinking`), `new-task-options`.
3. **Start button.** `SubmitSplitButton` now uses
   `SplitButton variant="default" size="sm"`, `SplitButtonMain` and
   `SplitButtonTrigger` inside a `DropdownMenuTrigger asChild`.
   - The divider is `primary-foreground/20`, from the split-button
     primitive.
   - The `Kbd` tint comes from `buttonVariants` default (`[&_kbd]:…`), so the
     one-off Kbd classes are gone.
   - The testids are kept: `new-task-submit` (with `data-action`,
     `aria-describedby`, `title`), `new-task-submit-menu`,
     `new-task-submit-{start,background,backlog}`, `new-task-submit-group`.
     The submit group still holds exactly 2 buttons.
   - The extra `<div className="shrink-0">` wrapper is gone (SplitButton is
     already `shrink-0`).
4. **Buttons, inputs and the role segment.**
   - The composer files had no `variant="outline"`.
   - "Attach a PR…" is now `Button variant="ghost" size="sm"` (a text
     action, so ghost rather than secondary).
   - The PR card's `Author | Reviewer` is `Segmented size="sm"`
     (`new-task-pr-role` with `data-role`, `new-task-pr-role-{author,reviewer}`).
   - The PR URL field and the Clone URL field are now `ui/Input` (32px,
     `bg-card`, focus `border-primary`). The clone field used to be a 28px
     hand-rolled input.
5. **Alignment.**
   - The PR block lost its `px-1` inset, so the URL field and PR card now
     line up with the prompt box edges. The screenshots showed them 4px
     narrower before.
   - Chips are 28px (`h-7`), Start is 28px (Button `sm`), and the mode
     track is 30px (24px segments + padding).
   - The Options popover's switch row was checked in a screenshot and needed
     no change.
6. **`tests/design-tokens.test.ts`.** The empty `PENDING_COMPOSER_PASS`
   set and its now-meaningless "allowlist only covers dirty files" test are
   gone. The banned-color scan covers every renderer file and passes.

Also added: a `new-task composer at 1200px and 800px` test in the
on-demand `scripts/screenshots/design-screenshots.spec.ts`. It is not part of
the e2e gate.

## Files modified (staged)

- `packages/app/src/renderer/src/components/ui/chip.tsx`: `ChipValue`,
  `valueTestId`, `valueClassName`, `overflowTitle`, `readOnly`, nowrap
  values, open state.
- `packages/app/src/renderer/src/components/ui/segmented.tsx`: attribute
  passthrough on the track, per-segment `data-selected`.
- `packages/app/src/renderer/src/components/NewTaskPickers.tsx`:
  `DetailChip` removed; Where, Agent, Model, Thinking and Options use `Chip`;
  `ModeSwitch` uses `Segmented`; `SubmitSplitButton` uses `SplitButton`.
- `packages/app/src/renderer/src/components/NewTaskComposer.tsx`: read-only
  PR chips and the Base chip use `Chip`; Attach a PR is a ghost `Button`;
  Clone URL is an `Input`; the submit wrapper div is gone.
- `packages/app/src/renderer/src/components/PullRequestField.tsx`: the role
  is a `Segmented`, the URL field is an `Input`, and the `px-1` inset is gone.
- `packages/app/tests/design-tokens.test.ts`: `PENDING_COMPOSER_PASS` removed.
- `packages/app/scripts/screenshots/design-screenshots.spec.ts`: composer
  screenshot test.
- `reports/screenshots/composer-*.png` (new) and `reports/composer-primitives.md`.

## Screenshots

These are offscreen, from
`npx playwright test -c scripts/screenshots/playwright.config.ts -g composer`.

- `reports/screenshots/composer-task-1200.png`
- `reports/screenshots/composer-task-800.png`
- `reports/screenshots/composer-options.png` (Options popover, 1200px)
- `reports/screenshots/composer-attach-pr.png` (Task mode PR URL field)
- `reports/screenshots/composer-review-1200.png`
- `reports/screenshots/composer-review-800.png` (PR card with the
  Author | Reviewer segment, read-only Repository and Base chips)

## Gate

| Step | Result |
|---|---|
| Targeted e2e: new-task-flow, claude-sessions, task-launching, inbox | 15/15 passed, run twice |
| `npx biome check .` | 0 errors; 8 warnings, all already on the base branch, none in touched files |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm test` | 117 files passed (1 skipped); 1250 tests passed (3 skipped) |
| `npm test -w @harbormaster/app` (e2e) | 122 passed (3.1 min) |
| `uncaughtException` lines | 0 |

## APPLY DURING MERGE

- **Visual change: the chip text is 13px now.** The shared Chip uses 13px
  text and pill radius, where DetailChip used 12px and an 8px radius. At
  1200px the Where / How row now wraps to two lines (Thinking, Options and
  Attach a PR go to line 2). That is the spec'd wrap behaviour, and no value
  is clipped (the e2e checks this), but it is a visible change from the old
  single line. If one line is wanted, shrink `Chip` itself; don't add a
  composer override.
- **The chip tooltip now shows only when the chip is clipped.** Before, every
  chip always had `title="<Label>: <value>"`. Now the full value is the
  tooltip only when the chip is wider than the row, and otherwise the hint
  title (shortcut text) shows. No test relied on the old titles.
- **Other `Segmented` users get a new attribute.** `data-selected` now
  appears on every segment, including the inbox tabs and ApprovalDetail.
  This is harmless, and nothing else matched on it there.
- **If another branch touched `DetailChip` or `PENDING_COMPOSER_PASS`,**
  re-point it to `Chip` / `ChipValue` and delete the allowlist.
- **Worktree-only files must stay out of the commit.** The `node_modules`
  symlinks under `packages/*` and the root are untracked and not staged.
