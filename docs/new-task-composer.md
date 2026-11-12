# New-task composer

Decision record for the new-task draft page (`NewTaskComposer.tsx`),
settled in a grilling session (2026-11-09). Style takes inspiration from the
shadcn AI Elements (Prompt Input / Model Selector) and the Astryx
"AI Chat Landing" template. The structure below is our own.

## Layout

Reworked 2026-11-12: the old single toolbar crammed six controls into the
prompt box and truncated their values (`a…`, `F`, `Pi · claud…`). Now:

- A centered column (~670px). The big borderless `Untitled task` title input
  stays on top and acts as the heading. While it is empty, its placeholder
  shows the title an empty title falls back to (the prompt's first line; in
  Review mode the PR's title, `Review: <title>` for a reviewer).
- Review mode (or Task mode's "Attach a PR…"): the PR block sits right under
  the title (see "Review mode").
- The prompt box (shadcn `InputGroup`): the prompt, and a footer with
  exactly two things: the `Task | Review | Chat` switch on the left and the
  labeled split submit button on the right. What the primary action still
  needs is the Start button's tooltip, its `aria-describedby`, and a muted
  inline note next to it (`Add a title or a prompt to start`), never a
  separate warning line.
- The "Where / How" row directly under the box: labelled chips with full
  values, `Repository <name> · Base <ref> · Agent <Pi|Claude Code> · Model
  <id> · Thinking <level> · Options`, plus a muted `Attach a PR…` link in
  Task mode. Each chip opens its picker. The row wraps to a second line
  when narrow; a value is never ellipsized (only a chip wider than the whole
  row is clipped, with the tooltip as the last resort). The Repository chip
  says `Folder` for a plain folder, `Clone` for a clone URL (its URL input
  sits under the row), `Where` for No folder.
- One muted line under the row: the derived branch name in full
  (`<slug>-… ← <base>`; the `…` is the task-id suffix core adds). Clicking
  it opens the Base picker. Without a branch it says what the Where implies
  (in place, scratch directory, chat in the checkout, clone).

## Task / Review / Chat

A three-option switch in the prompt box footer. A fresh draft always opens
on Task (Review and Chat are per-draft choices, never sticky):

- **Task**: a repository gets its own branch + worktree, tracked on the board.
  The PR field is hidden; `Attach a PR…` reveals it for the "continue my
  own PR" case (always role `author`).
- **Review**: the task works on an existing pull request (see "Review mode").
- **Chat**: never a worktree. With a repository the agent runs in place in the
  repository's primary checkout, so questions have the code as context (edits
  land directly in that checkout; the composer says so). Core stores it as a
  `folderPath` task with no `repositoryId` (`inPlace` on create/launch), so
  Done/delete/branch-follow never treat the checkout as a task worktree.
  Chat ignores any PR URL left over from another mode.

## Review mode

- The PR URL field is the first control under the title, autofocused; the
  prompt placeholder becomes `What should the review focus on?`.
- A pasted URL is looked up through core, `previewPullRequest(url)` (a
  `CoreCommands` verb over `PullRequestAccess.view`, i.e. GithubPrAccess;
  the renderer never runs gh). It rejects readably when the URL is not a
  PR, the repository has no local checkout, or GitHub cannot be reached.
  While resolving the field shows a spinner; a failure shows inline under
  it and the field stays editable.
- Once resolved the field becomes a compact card:
  `#<number> · <title> · by <author> · <head> → <base>` with a remove (×).
- Repository, Base and the branch line (`<head> ← <base>`) are read-only
  and come from the PR.
- The role defaults from the PR (`viewerIsAuthor` → Author, else Reviewer);
  a small `Author | Reviewer` segment on the card overrides it.
- Start / Park create the task through the same path the inbox's "Create
  review task" ends in: `createTask` with `repositoryId`, `pullRequest` and
  an explicit `role`. Starting checks out the PR head; a reviewer never
  pushes or opens a PR. A PR task never runs in the background.

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

- Two dropdowns (wave B, decision R8): **Agent** (`Default (<agent>)`, Pi,
  Claude Code, configured custom CLIs) and **Model**, which lists only the
  chosen agent's models. `Default` resolves to the parent's agent for a
  child, else the repository's `defaultHarness`, else
  `launch.defaultHarness`, else Pi; core stores the resolved id on the task.
  Picking a concrete model pins its agent.
- Model top entry: `Default (<resolved model>)`.
- Thinking level is its own chip (`Thinking <level>`), shown only for
  models that support it; its value is the pick, else the agent's default.
- It applies to Start, Park and background launch alike, and is stored on
  the task (`Task.harness` / `model` / `thinking`). A parked task uses it when
  it eventually starts. The composer remembers the last pick.
- The agent is fixed per task: resumes and forks always use it. The data
  model must not rule out several sessions per task later.
- Model and thinking are applied only to the task's first session launch.
  `launch.defaultModel` belongs to the default agent only.

## Options

Advanced, rarely changed choices sit behind one dashed `Options ▾` chip at
the end of the row. The chip's label lists what differs from the default,
e.g. `Options · parent: Fix MEV · skip prompts: off`.

- **Skip permission prompts**: a plain switch (decision R7, no warning
  colour) deciding whether a *Run in background* launch skips the agent's
  permission prompts (Claude Code's `--dangerously-skip-permissions`; Pi has
  none). It starts on the repository / app default (`bypassPermissions`,
  default on) and is never sticky. Start & open never bypasses: interactive
  panes keep the user's own settings.
- **Parent task**: never pre-filled. Manual drafts are almost always
  standalone; subtasks usually come from agents via the launch tool.
  `Choose…` turns the popover into a searchable task picker with the
  focused task suggested first. Tasks that are themselves children are not
  offered (one level only). Once set, the row shows the parent with a
  remove (×).
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
blocked; a blocked row adds what is missing, and the muted note next to
the button (also its tooltip and description) names what the primary
action still needs.

## Base branch

A child in its parent's repository stacks on the parent's branch by default;
everything else branches off the default branch. Any ref can be picked from
the Base chip or the branch line (`baseRef`). A PR task's base is the PR's.

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

⌘P Repository (Where) · ⌘⇧M Model · ⌘⇧P Parent (the Options popover, on
its task search). Each picker opens with its search focused and returns
focus to the prompt.

## Task rows

Sidebar rows show the agent and model: `pi · claude-opus-4-8 · your move`
(revised from the original "agent only" decision). The model is the task's
own choice, else what its first session started with (`Task.sessionModel`,
recorded by `claimSessionLaunch`: the configured default, else the harness's
own default from `HarnessAdapter.defaults()`); just `pi` when unknown. The
thinking level is in the tooltip.

## Out of scope

Agent profiles, switching agents
mid-task, in-place *tasks* for git repositories (only chats run in place).
