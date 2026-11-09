# New-task composer

Decision record for the new-task draft page (`NewTaskComposer.tsx`),
settled in a grilling session (2026-11-09). Style takes inspiration from the
shadcn AI Elements (Prompt Input / Model Selector) and the Astryx
"AI Chat Landing" template. The structure below is our own.

## Layout

- A centered column (~670px). The big borderless `Untitled task` title input
  stays on top and acts as the heading. While it is empty, its placeholder
  shows the title derived from the prompt.
- One rounded composer card (shadcn `InputGroup`): a context tray on top
  (shown only while a parent is set), then the prompt, then a toolbar inside
  the card's bottom edge.
- Toolbar: `Task | Chat` switch · `Where ▾` · `Agent · Model ▾` · muted
  `+ Parent`, and a labeled split submit button on the right.
- One muted line under the card: the branch preview
  (`<slug>-… ← <base> ▾`). Clicking the base opens a branch picker.

## Task / Chat

A two-option switch next to Where (like other harnesses), remembered across
drafts:

- **Task**: a repository gets its own branch + worktree, tracked on the board.
- **Chat**: never a worktree. With a repository the agent runs in place in the
  repository's primary checkout, so questions have the code as context (edits
  land directly in that checkout; the composer says so). Core stores it as a
  `folderPath` task with no `repositoryId` (`inPlace` on create/launch), so
  Done/delete/branch-follow never treat the checkout as a task worktree.

## Where

One searchable picker: Recent, Repositories (discovered under `codeRoot`
plus registered git folders), Folders (registered non-git folders),
`Open folder…` (native dialog), `Clone URL…`, `No folder` (an empty scratch
directory, in either mode).

- Default: the focused task's repository, else the last one used.
- In Task mode a git repository always gets its own branch + worktree; Chat
  mode runs in its checkout instead (see above).
- A non-git folder runs in place: its binding points at the folder itself
  (`inPlace: true`). Nothing in core ever deletes or git-touches it.
- Opened folders are registered in core state (`<stateDir>/locations.json`,
  behind `FolderAccess`; not the user-edited config file), so every client,
  including the agent launch tool, can target them by name or path.
- Clone URL works on every submit path, not only background launches.

## Agent · Model

- One picker grouped by agent (harness). Pi is the only harness today; the
  picker structure is ready for Claude Code.
- Top entry: `Default (<harness>: <resolved model> · <thinking>)`.
- Thinking level sits inside the same menu, only for models that support it.
- It applies to Start, Park and background launch alike, and is stored on
  the task (`Task.harness` / `model` / `thinking`). A parked task uses it when
  it eventually starts. The composer remembers the last pick.
- The agent is fixed per task: resumes and forks always use it. The data
  model must not rule out several sessions per task later.
- Model and thinking are applied only to the task's first session launch.

## Parent

- A muted `+ Parent` affordance, never pre-filled. Manual drafts are almost
  always standalone; subtasks usually come from agents via the launch tool.
- It opens a searchable task picker with the focused task suggested first.
  Tasks that are themselves children are not offered (one level only).
- Once set, it shows as a pill in the tray: `↳ <task> ×`.
- The composer no longer offers "standalone with provenance". Provenance is
  still recorded for agent-launched standalone tasks.

## Submit

A split button whose label always names the action:

- With no parent the default is `Start` (start and open). With a parent set
  the default is `Run in background` (the child appears nested in the
  sidebar and focus stays put).
- The menu always offers Start & open · Run in background · Park in backlog.
- ⌘↵ runs the default action, ⌥⌘↵ the other of Start / Run in background.

Every menu row says what the action does (mode-aware), even while it is
blocked; a blocked row adds what is missing, and a single hint under the card
names what the primary action still needs.

## Base branch

A child in its parent's repository stacks on the parent's branch by default;
everything else branches off the default branch. Any ref can be picked from
the preview line (`baseRef`).

## Paste / drop

Pasting or dropping into the prompt goes through the same resolver as
terminal panes: Finder files become paths, a clipboard image is saved to a
temp PNG and pasted as its path, text stays text. The path is inserted
inline at the cursor, exactly like chat. On submit, pasted images are copied
into the task's state directory (`<stateDir>/task-attachments/<taskId>/`) and
the prompt is rewritten to point there, so a parked task never ends up with
a dead temp path.

## Model list

`HarnessAdapter.listModels()`; Pi's comes from `pi --list-models` plus Pi's
own settings (`defaultModel` / `defaultThinkingLevel`), cached for 5 minutes.
A configured `launch.defaultModel` wins as the default. e2e never spawns the
fake `pi` for this: set `HARBORMASTER_PI_LIST_MODELS_COMMAND` to a stand-in.

## Keyboard

⌘P Where · ⌘⇧M Agent·Model · ⌘⇧P Parent. Each picker opens with its search
focused and returns focus to the prompt.

## Task rows

Sidebar rows show the agent and model: `pi · claude-opus-4-8 · your move`
(revised from the original "agent only" decision). The model is the task's
own choice, else what its first session started with (`Task.sessionModel`,
recorded by `claimSessionLaunch`: the configured default, else the harness's
own default from `HarnessAdapter.defaults()`); just `pi` when unknown. The
thinking level is in the tooltip.

## Out of scope

The Claude Code adapter (a follow-up), agent profiles, switching agents
mid-task, in-place *tasks* for git repositories (only chats run in place).
