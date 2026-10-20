# Sidebar ordering: fixed order, user drag-and-drop reorder

Status: planned 2026-10-20. Scope: `packages/app` renderer only (no core/API change).

## Problem

Sidebar rows (open task workspaces) reshuffle constantly. Cause, in
`packages/app/src/renderer/src/components/sidebar-model.ts`:

- `sidebarRows()` emits rows in **board order** (column, then core's
  `stateChangedAt` sort) — a Dev→Awaiting move reorders the rail.
- `groupRows()` then re-sorts each group by **activity** (`activityRank`:
  running turn → live → rest) — every pi turn start/stop reorders the rail.

## Decision

Order is **fixed and user-owned**. Nothing reorders rows except an explicit
user drag. Prior art studied: dnd-kit Sortable preset + its SortableTree
example (flattened tree, projected depth, hide active's descendants while
dragging), cmux workspace-group DnD (manaflow-ai/cmux #5034, #6532/#6724:
no-op-drop suppression, pinned tier separation, groups move as a block,
don't force-expand collapsed groups during drags), openchamber's
`drag-to-reorder` skill (translate-not-transform, reorder once on drop,
stable ids, no reorder in onDragOver).

Reuse: the board uses `@dnd-kit/core` 6.3.1 with column-level droppables
(no sortable). The sidebar needs `@dnd-kit/sortable` 10.0.0 (same project,
peer `@dnd-kit/core ^6.3.0`). Only the board's drag *guards* are shared
(extracted hook); a generic "drag component" would hide two different
behaviours behind flags and is explicitly not wanted.

## Requirements (numbered — every one must be implemented and reported on)

### A. Ordering model (pure, unit-tested)

- **R1** Remove the activity sort (`activityRank` in `groupRows`) and the
  board-order dependency. Rail order never changes because of presence,
  column moves, PR updates, renames, or any core push.
- **R2** Persist a single global task order: localStorage key
  `harbormaster.sidebar.taskOrder` (string[] of task ids), helpers in
  `lib/sidebar-persistence.ts` following the existing `StorageLike` pattern.
  Within any section, rows sort by their index in this list.
- **R3** Opening a task that isn't in the stored order appends it at the end
  (so it appears at the **bottom** of its repo group / section). Ids missing
  from the stored list (legacy state) sort after all known ids, in
  `openedTaskIds` insertion order — never board order. App's `openTask`
  path (App.tsx) is the place that appends.
- **R4** Closing a task (App.tsx `closeTask`, the single close path) removes
  its id from the stored task order and from the detached set (R12), so a
  reopen lands at the bottom (R3). Must not run during startup restore:
  nothing may prune the stored order based on a not-yet-restored
  `openedTaskIds` (restore is async — see `restoreComplete` in App.tsx).
- **R5** Persist repo-group order: key `harbormaster.sidebar.groupOrder`
  (string[] of group labels as produced by `repoLabel`). Groups sort by
  stored index; labels not in the list come after, in the current default
  (alphabetical, `scratch` last). A new repo group therefore appears at the
  bottom.
- **R6** All ordering/projection logic lives in pure functions (no React, no
  `window`) in `components/sidebar-model.ts` and/or a new
  `lib/sidebar-order.ts`, with vitest coverage in `packages/app/tests/`
  (extend `sidebar-model.test.ts`, `sidebar-persistence.test.ts`, add
  `sidebar-order.test.ts` as needed): merge/sort, append-on-open,
  remove-on-close, group order with unknown labels, every drop projection
  case in R10–R15, and no-op detection (R17).

### B. Task-row drag and drop

- **R7** Rows are draggable with `@dnd-kit/sortable` (`useSortable`) inside
  one `SortableContext` per section (the Pinned section and each repo group)
  using `verticalListSortingStrategy`. Sortable ids are namespaced
  (`task:<id>`, `group:<label>`) so group and task ids can never collide.
- **R8** **No cross-section drops.** A task row can only be dropped within
  its own section (its repo group, or Pinned if pinned). Enforce in custom
  collision detection by filtering `droppableContainers` to the active
  item's kind + section (attach `data: { kind, section }` to each
  sortable); dropping anywhere else (other group, header, outside the
  sidebar) cancels with no change. Pinning/unpinning stays a context-menu
  action, not a drag.
- **R9** Drag is committed **once, on drop** (`onDragEnd`), by id
  (`arrayMove` on ids, never array indices). No state reorder in
  `onDragOver`.

### C. Lineage (children) rules

Today `layoutLineageRows` (lib/task-lineage.ts, shared with the Board)
nests a child directly under its parent when both are in the same rendering
group; children are sorted by `createdAt`.

- **R10** Dragging a **top-level** row moves it with its nested children as
  one block. While it's dragged, its nested children are hidden (dnd-kit
  SortableTree pattern) and reappear under it after the drop.
- **R11** A **nested child** is draggable on its own. Dropping it inside its
  parent's nested block (between the parent row and the block's last
  child) reorders it among its siblings; sibling order follows the global
  task order (R2), not `createdAt`, in the sidebar.
- **R12** Dropping a nested child **outside** its parent's block (anywhere
  else in the same section) **detaches** it: it becomes a top-level row at
  the drop position, rendered with the existing muted "↳ <parent title>"
  line (`parentTitle`). Persist detached child ids in
  `harbormaster.sidebar.detachedChildIds` (string[]).
- **R13** A detached child dropped back inside its own parent's block is
  re-attached (removed from the detached set). If that parent's children
  are collapsed (lineage chip), re-attaching expands it (updates the shared
  `harbormaster.lineage.collapsedParents` set) so the row doesn't vanish.
- **R14** Ambiguous boundary — dropping just below the last child of the
  block (position "end of block" vs "right after the block"): decide by
  horizontal pointer offset, SortableTree-style. Attached unless the drag
  has moved left by at least the nesting indent (the `ml-3` + `pl-1`
  indent of nested rows, ~16px); a child already detached is attached at
  that boundary only if moved right by at least the indent. The in-place
  placeholder row renders with the **projected** indentation during the
  drag, so the user sees attach vs detach before releasing.
- **R15** Only children may be nested; a non-child (or a child of a
  different parent) can never be dropped *into* a block. To make that
  impossible rather than corrected after the fact, **while any task drag is
  active, every nested block in that section is hidden except the dragged
  child's own parent's block** (the dragged row's own children are hidden
  per R10). Every visible row is then either top-level or a sibling of the
  dragged child, so the visual slot always equals the committed result. Do
  not mutate the saved lineage-collapse state for this; it is a drag-only
  render override (same idea as the board's `peekedColumns`).
- **R16** The Board is unchanged: `layoutLineageRows` keeps its current
  behaviour for board callers; new behaviour (detached set, sibling order
  from a supplied order) is opt-in via optional parameters. Existing
  `task-lineage.test.ts` must still pass unmodified (add new cases, don't
  rewrite old ones).

### D. Repo-group drag and drop

- **R17** Repo group headers are draggable to reorder groups
  (`SortableContext` of `group:<label>` ids, vertical strategy). The Pinned
  section is not a group: always first, not draggable, not a drop target.
  A group can only be dropped among groups (R8 filtering by kind).
- **R18** While a group is dragged, all group bodies render collapsed
  (headers only) so groups are uniform-height rows; the saved
  `collapsedGroups` state is **not** touched and is restored on drop/cancel.
  The DragOverlay shows the header only.
- **R19** No-op suppression: dropping a task or group where it started (or
  a projection equal to the current order and attachment) writes nothing
  and causes no re-render churn (cmux #6532 bug class).

### E. Drag gotchas (each must be handled)

- **R20** Sensor: `PointerSensor` with `activationConstraint: { distance: 4 }`
  (board parity) so a plain click still selects the row, and right-click
  (context menu) never starts a drag. Don't spread `listeners` onto the
  close button, PR chip, lineage chip, or rename input in a way that
  breaks them. Verify each still works after a drag-capable row ships.
- **R21** Click-after-drag suppression and Escape-key guard: extract the
  board's `draggedRef`/`clearDraggedSoon` and
  `dragKeyGuardRef`/`releaseDragKeyGuardSoon` logic (Board.tsx) into a
  shared hook (e.g. `lib/use-drag-guards.ts`) used by **both** Board and
  Sidebar. A completed drag must not also select/open the task; Escape that
  cancels a drag must not also trigger any other Escape handler (sidebar
  search clear, board back-to-workspace).
- **R22** Preview: `DragOverlay` portaled to `document.body` (board
  pattern) because the sidebar list is an `overflow-y-auto` scroller. The
  in-flow source row becomes the placeholder (dimmed, projected indent per
  R14). Use `CSS.Translate.toString` (never `CSS.Transform`, which scales
  variable-height rows).
- **R23** Auto-scroll: dragging near the top/bottom edge of the sidebar
  list scrolls it (dnd-kit autoScroll, default on — make sure the
  scroller is the sortable's scroll ancestor). Use
  `MeasuringStrategy.Always` for droppables, since rows hide/show at drag
  start (R10/R15/R18) and stale rects mis-target drops.
- **R24** Live data mid-drag: the order is frozen during a drag (core
  pushes keep re-rendering rows). If the dragged task disappears mid-drag
  (closed elsewhere, archived), cancel cleanly — no throw, no write.
- **R25** Disabled states: no dragging while the search filter is
  non-empty (reordering a filtered list is ambiguous), while a row is being
  renamed, or in the collapsed icon rail. Disabled rows behave exactly as
  today.
- **R26** Don't break existing DnD/pointer features: the terminal
  file-drop (native HTML5 DnD, `lib/terminal-host/drop.ts`) and the sidebar
  width resize handle (pointer capture) must keep working; rows must not
  get a native `draggable` attribute.
- **R27** Accessibility: screen-reader announcements in task/group terms
  (titles and section names, not raw ids), like the board's
  `announcements`. Keyboard sorting is out of scope (dnd-kit's
  KeyboardSensor activates on Enter/Space, which would steal row
  activation); say so in a code comment.

### F. Consumers of the order

- **R28** Everything that reads rail order follows the new order:
  `visibleTaskOrder` (Cmd/Ctrl+Shift+Up/Down cycling, scroll-to-current),
  the collapsed icon rail (currently iterates `groups` — must use the same
  ordered groups/rows, pinned first), and `partitionPinned` (pinned rows
  ordered by the global task order, not board order). Update the stale doc
  comments in `sidebar-model.ts` that describe running-first / board order.

### G. Tests and gate

- **R29** Unit tests per R6 (pure logic covers every R10–R15, R17, R19
  case).
- **R30** One new e2e spec `packages/app/e2e/sidebar-reorder.spec.ts`
  (single fixture/launch, merged tests, condition waits, no sleeps; reuse
  pointer-drag helpers from `e2e/board-gestures.ts` if suitable) proving
  through real pointer drags:
  (a) a presence change / column move does **not** reorder rows;
  (b) dragging a row reorders within its group and survives a window
      reload;
  (c) dropping a row onto another repo group does nothing;
  (d) dragging a repo group header reorders groups;
  (e) dragging a nested child out of its parent's block detaches it
      (renders "↳ parent" line), and dragging it back re-attaches it;
  (f) a plain click on a row still selects it and a drag doesn't.
  Each assertion must be shown to **fail** with the feature reverted (run
  only this spec for the revert check), then restored. Close every
  Electron app launched.
- **R31** Existing board e2e (`board-drag-collapse.spec.ts`) and
  `orca-polish.spec.ts` (sidebar pins/rename/context menu/cycling) still
  pass — the shared drag-guard extraction (R21) touches the board.
- **R32** During development run ONLY the targeted specs/unit files you
  touch (`npx vitest run <file>`, `npx playwright test e2e/<spec>.spec.ts`
  after `npx electron-vite build`). Never run the full e2e suite or
  `npm test -w @harbormaster/app` mid-work. Full gate exactly once at the end: biome → lint → typecheck → `npm test`
  → `npm test -w @harbormaster/app`, zero `uncaughtException` lines.
- **R33** Add `@dnd-kit/sortable` `10.0.0` (exact pin, matching the other
  dnd-kit entries) to `packages/app/package.json` dependencies.
- **R34** Record the decision in `docs/design-decisions.md` (one short
  entry: fixed user-owned rail order, sortable within section, group
  reorder, child detach) and update the `sidebar-model.ts` module header.
