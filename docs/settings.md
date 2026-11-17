# Settings

Decision record for the Settings page (grilling session, 2026-11-17). Where
this file and older docs disagree about settings, this file wins.

Research basis: VS Code (settings described by a schema, the Settings editor
drawn from it, one generic write `update(key, value)`, features react via
`onDidChangeConfiguration` / `affectsConfiguration`), Zed's 2025 settings
rebuild (one typed model "starting from the files"; scattered definitions
caused hidden side effects that broke auto-update), JetBrains (hand-written
panels with Apply: the style we avoid), and platform guidelines (Microsoft,
Material, Android, Firefox Acorn, GitLab Pajamas): few settings with smart
defaults, values readable at a glance, apply immediately, explain anything
inherited or locked.

## Decisions

| # | Decision |
|---|---|
| S1 | **Coverage: common options only.** Everyday options get controls; rare, complex ones (deployment pipelines, the inbox CEL `priorityFilter`, custom agent fields, per-repository overrides) stay in `config.json`, reached via an "Edit in config.json" button. |
| S2 | **A page**, like Inbox / Rules / Costs (`isPage`): opened with `Cmd+,` and the app menu, Esc / back returns to the workspace. Not a dockview tab, not a modal. |
| S3 | **Shared sections.** Each Settings section is one self-contained component; wizard steps render the same components inside their step header (as `CodeReviewSettings` already does). The menu item "Welcome / Setup…" becomes **"Settings…" (`Cmd+,`)**; the wizard runs automatically on first launch only, and Settings has a "Run setup again" link at the bottom. Startup behaviour is unchanged. |
| S4 | **Live config file.** Core watches `config.json` (in the config access service); hand edits reach open UIs within about a second through a config-changed event. An invalid file shows a clear error ("config.json: <problem>") in Settings and core keeps the last good config. |
| S5 | **Changes apply immediately.** No Save button. Switches/selects apply on change; text and number fields commit on Enter or blur after validation (invalid → inline hint, not saved). Every setting has reset-to-default. |
| S6 | **One settings description + generic checked update + change reactions.** A single core-owned description of every UI-exposed setting (key path, type, default, allowed range/values, title, help text, section). One generic `updateSettings` command validates against it and writes atomically. Side effects live in **reactions to config changes**, run for UI writes *and* hand edits alike (e.g. `codeRoot` changed → repository rediscovery; default agent changed → availability check). Real actions that are not "set a value" stay named commands (connect GitHub, run setup again, …). Existing per-setting commands (`setCaptureAgentBrowser`, `setSourceEnabled`, `setRulesEnabled`, `setDefaultAgent`, `setCodeRoot`) may stay as thin wrappers or be migrated; behaviour must not regress. |
| S7 | **Layout: sections on the left**, most used first: **General**, **Agents**, **Code review**, **GitHub & sources**, **Inbox & messaging**, (later) **Repositories**. Footer: "Edit in config.json", "Run setup again". |
| S8 | **Per-repository settings later.** No Repositories section in v1; repo overrides stay file-only. Global settings that a repository overrides show a hint: "Overridden in N repositories". |
| S9 | **Custom agents: list only.** The Agents section lists custom agents (label, command, found ✓ / not found) and they are pickable as the default agent; adding/editing goes through "Edit in config.json". |
| S10 | **GitHub & sources:** a hand-designed GitHub panel (account status + reconnect, friendly toggles "Create a task when someone requests my review" / "…mentions me", check interval in **minutes**); every other source (add-ons) gets an on/off switch and a form drawn automatically from its `settingsSchema`. Source schemas may carry a friendly `title` per option, used by the automatic forms. Version-endpoint stays per-repository (file). |
| S11 | **New settings:** **notifications** (on/off, replacing the hidden `harbormaster.notifications` localStorage escape hatch; `HARBORMASTER_NOTIFICATIONS=off` stays as the process-level kill switch) and **terminal font size** (General, default 13, applied live to open panes with a refit). Later: default "Open in" app, automatic worktree cleanup, light theme. |
| S12 | **"Changed" markers now, search later.** A dot next to every setting that differs from its default, paired with reset. No search box in v1 (≈20 settings in 6 named sections). |
| S13 | **Automation switch stays on the Rules page** (already exists, `setRulesEnabled`). Settings → General shows its state with a link ("Automation is on · Manage rules →"). The board shows an "Automation paused" banner while it is off. |
| S14 | **Delivery in three steps**, each green on `main` before the next: (1) foundation, (2) Settings page + General / Agents / Code review + wizard reuse + menu, (3) GitHub & sources, Inbox & messaging, notifications, automation link + banner. **Delivered** (all three steps; see the implementation notes below). |

## Settings in v1

| Section | Setting | Config key | Notes |
|---|---|---|---|
| General | Code folder | `codeRoot` | change → rediscovery (reaction) |
| General | Branch prefix | `branchPrefix` | e.g. `alice/`, may be empty |
| General | Terminal font size | new (e.g. `terminal.fontSize`) | default 13, live |
| General | Automation | `automation` | read-only state + link to Rules (S13) |
| Agents | Default agent | `launch.defaultHarness` | built-ins + custom agents; "overridden in N repos" |
| Agents | Default model | `launch.defaultModel` | applies to the default agent only |
| Agents | Skip permission prompts for launched tasks | `launch.bypassPermissions` | "overridden in N repos" |
| Agents | Max tasks running at once | `launch.maxConcurrent` | default 6 |
| Agents | Custom agents | `agents.custom[]` | list only (S9) |
| Code review | Plannotator status per agent | — | `CodeReviewSettings` |
| Code review | Open agents' local pages in the app | `captureAgentBrowser` | |
| GitHub & sources | GitHub account | — | status + reconnect (action) |
| GitHub & sources | GitHub on/off | `sources.github.enabled` | |
| GitHub & sources | Review requests / mentions / interval | `sources.github.settings.*` | interval shown in minutes |
| GitHub & sources | Add-on sources | `sources.<id>.*` | automatic forms |
| Inbox & messaging | Parent reply timeout | `messaging.parentReplyTimeoutMinutes` | default 30 |
| Inbox & messaging | Message loop cap | `messaging.loopCap` | default 8 |
| Inbox & messaging | Priority filter | `inbox.priorityFilter` | "Edit in config.json" only |
| (Notifications) | Desktop notifications | new (e.g. `notifications.enabled`) | section: General unless a better home emerges |

## Architecture constraints

- The renderer never reads or writes `config.json`; everything goes through
  core commands and events (AGENTS.md: core is headless, API transportable).
- The file watcher and atomic writes live in the config access service;
  reactions live in the manager; the settings description is a core contract
  (transportable, no Electron types).
- Writes made by core itself must not loop through the watcher as
  "external" edits (dedupe by content or a write token).

## Implementation notes (step 1: foundation)

- **Description:** `SETTINGS_DESCRIPTION` in `packages/core/src/contracts/settings.ts`
  (types `SettingDescription`, `SettingSectionId` = `general | agents |
  code-review | github | inbox`, `SettingType` = `boolean | integer | string |
  enum | harness`). Validation is the pure `engines/settings.ts`
  (`validateSettingsPatch`, `changedConfigKeys`, `affectsConfiguration`).
- **New config keys:** `terminal.fontSize` (integer 8–32, default 13) and
  `notifications.enabled` (boolean, default `true`), both on `GlobalConfig`.
- **Commands:** `getSettings(): SettingsSnapshot` (description, effective
  `values`, `explicit` keys, `overriddenIn` counts for `launch.defaultHarness`
  / `launch.bypassPermissions`, `harnesses` choices, `error`) and
  `updateSettings(patch: Record<key, value | null>)` (`null` removes the key;
  written through `JsonConfigAccess.applySettings({ set })` under the config
  lock). IPC: `core:getSettings`, `core:updateSettings`; preload
  `core.getSettings / updateSettings / onConfigChanged`.
- **Event:** `config-changed` `{ changedKeys, origin: "core" | "file", error? }`,
  forwarded to windows as `core:config-changed`.
- **Watcher:** `JsonConfigAccess.startWatching()` (fs.watch on the state dir,
  150 ms debounce), enabled by `createCore({ watchConfig: true })` (the app
  only) and stopped by `Core.close()`. Unchanged file text is never re-parsed
  or re-reported, so core's own writes do not come back as hand edits. An
  invalid file keeps the last good config; `error` carries the message (and
  line/column for JSON syntax errors).
- **Reactions** (`manager/settings-runtime.ts`, any origin): `codeRoot` /
  `repositories.*` → repository rediscovery; `launch.defaultHarness` →
  availability check (logged); `automation` and `sources.*` need only the
  event (the refresh tick reads both fresh). The per-setting commands
  (`setCodeRoot`, `setDefaultAgent`, `setRulesEnabled`, `setSourceEnabled`,
  `setCaptureAgentBrowser`) are unchanged and flow through the same reactions.
- **Terminal font size** is live already: `renderer/src/lib/terminal-font-size.ts`
  feeds `createTerminalOptions({ fontSize })` and refits open panes.

## Implementation notes (step 2: page, General / Agents / Code review, menu)

- **Page:** `view === "settings"` in `App.tsx` (`isPage`; Esc / "Done" go
  back). Opened by Cmd/Ctrl+, (renderer keydown, idempotent) and the app
  menu's **Settings…** (`id: "settings"`, accelerator `CmdOrCtrl+,`; main
  sends `app:show-settings`, preload `app.onShowSettings`). The old
  "Welcome / Setup…" item and the `onboarding:show` channel are gone; the
  footer's **Run setup again** opens the wizard overlay (`OnboardingGate`
  passes `onRunSetup` into `App`). First-launch behaviour is unchanged.
- **Components:** `components/settings/` — `SettingsView` (section nav,
  config.json problem banner, footer), one component per section
  (`GeneralSection`, `AgentsSection`, `CodeReviewSection`), and
  `SettingRow.tsx` (`SettingRow` / `SettingsCard` presentational, shared with
  the wizard's permission switch; `DescribedSetting` draws a row from
  `SETTINGS_DESCRIPTION`: boolean → Switch, integer / string → `CommitField`
  committing on Enter/blur, enum / harness → `SelectField`; changed dot,
  reset → `null`, inline rejection). Model: `lib/use-settings.ts`
  (`getSettings` re-read on every `config-changed`; newest read wins). Pure
  helpers: `lib/settings-form.ts` (tests/settings-form.test.ts).
- **Edit in config.json:** IPC `app:openConfigFile(appId?)`; main resolves
  the path itself and opens it in the last-used / first installed "Open in"
  editor, else `shell.openPath`. `HARBORMASTER_OPEN_IN_STUB` records it.
- **Custom agents:** `detectAgents()` now appends `agents.custom[]` entries
  (`custom: true`, located on PATH only, never run); the Agents list uses it.
  The wizard still shows only the built-ins plus "Keep <custom>".
- **Default model:** a select from `listModels()` for the default agent
  ("Agent default" = reset, an unlisted configured model kept); free text
  when the catalog has no models.
- **Code review:** `CodeReviewSettings` with the current default agent (its
  inner heading is now "Plannotator review").
- **e2e:** `e2e/settings.spec.ts` (Cmd+, → range hint → commit → dot/reset →
  reset → hand edit live → invalid file banner → fixed → Edit in config.json
  → Esc). onboarding / plannotator specs reach the wizard / Code review via
  the Settings menu item.

## Implementation notes (step 3: GitHub & sources, Inbox & messaging, notifications, banner)

- **Source settings API (S10): the generic path, no new command.**
  `updateSettings` accepts `sources.<id>.enabled` (boolean) and
  `sources.<id>.settings.<property>` (boolean / number / string; `null`
  removes it) for any registered source, described or not. Validation
  (`engines/settings.ts`: `sourceSettingKey`, `validateSettingsPatch` with
  `sources` + `sourceSettings` in its context): the source must be
  registered, the property declared in its schema's `properties`, and the
  source's whole settings object, merged with the patch, must pass its own
  `settingsSchema` (ajv, `engines/rules/source-settings.ts`) — otherwise
  nothing is written. Described github keys are checked by their
  description *and* the schema. Anything non-scalar (arrays, objects)
  stays "Edit in config.json".
- **Read:** `SettingsSnapshot.sources: SettingsSource[]` — every registered
  source (built-ins, then loaded add-ons; from the rules runtime's
  `listAddons`, `builtinSources` on a core without rules): `id`, `label`
  (the source's new optional `title`, else the id), `builtin`, `addon`
  (name, description), `enabled`, `enabledExplicit`, `settingsSchema`,
  `settings`, `explicit` property names, and `problems` (the configured
  settings fail the schema: the source is off). Hand edits keep flowing via
  `config-changed` → `getSettings`.
- **GitHub defaults** live in `contracts/settings.ts`
  (`DEFAULT_GITHUB_SEARCH_INTERVAL_MS`, `DEFAULT_GITHUB_WATCH_*`); the
  github source applies exactly these and its schema carries them as
  `default` plus `title`s (a unit test pins description = schema).
- **GitHub & sources section** (`components/settings/GithubSection.tsx`):
  account status from `onboarding.githubAuthStatus` (the wizard's GitHub
  step's call) with Recheck; the github rows are `DescribedSetting`s; the
  interval is a `CommitField` showing minutes (`format`) and committing ms
  (`parseMinutesDraft`). Add-on sources (`autoFormSources`: every add-on
  source, plus built-ins with options other than github / version-endpoint)
  get a card with an on/off switch and rows from `sourceFormFields(schema)`:
  boolean → switch, integer / number → number field (`minimum` /
  `maximum`), string → text field (empty resets), string `enum` → select,
  anything else → "Edit in config.json". Schema `title` is the row label
  (else the property name), `description` the help, `default` the value
  shown while unset. Changed dot + reset per property.
- **Inbox & messaging section** (`InboxSection.tsx`): parent reply timeout
  (with a "min" suffix for `unit: "minutes"`) and loop cap as described
  rows; "Inbox priority filter" shows whether a custom filter is set (and
  the expression) with only "Edit in config.json" (S1).
- **Notifications (S11):** General → "Desktop notifications"
  (`notifications.enabled`). `useTaskNotifications` reads it live from
  `lib/config-values.ts` (a shared store of `getSettings` values /
  explicit keys, re-read on every `config-changed`); decision
  `notificationsEnabled` in `lib/notifications.ts`. One-time migration on
  the first settings read (`notificationsMigration`): a legacy
  `harbormaster.notifications = "off"` with the key unset writes
  `notifications.enabled = false` via `updateSettings`, then the
  localStorage key is removed (any other legacy value is just removed).
  Main's `HARBORMASTER_NOTIFICATIONS=off` kill switch is unchanged. The
  unread dot is not affected by the setting.
- **Automation paused banner (S13):** `components/AutomationPausedBanner.tsx`
  under the board header while `automation` is false ("Automation paused ·
  Rules won't move cards", **Turn on** = `setRulesEnabled(true)`, **Open
  Rules**); follows config.json live through the same store.
- **Polish:** Code review lists agents by label (`ReviewSupportHarness.label`,
  filled by core from the adapter, so custom agents show "Aider", not
  "aider"); `SelectField` is `w-64`, the width of the text fields.
- **e2e:** `e2e/settings.spec.ts` gained three tests on the same launch (fake
  gh signed in as `octo-e2e`, a `pinger` add-on fixture in
  `<stateDir>/addons/`): GitHub & sources (account, toggles,
  minutes ⇄ ms incl. a hand edit, add-on form + schema bounds + reset);
  Inbox & messaging + notifications switch; the board banner (hand edit off
  → shown, on → gone, Turn on). `e2e/orca-polish.spec.ts`'s notify test
  now also proves `notifications.enabled = false` sends no `app:notify`.
