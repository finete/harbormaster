// The settings description (docs/settings.md decision S6): one core-owned,
// transportable list of every UI-exposed config setting — key path, type,
// default, constraints, title, help text and section. Frontends draw the
// Settings page from it; `CoreCommands.updateSettings` validates writes
// against it (engines/settings.ts). Plain data only: no functions, no
// Electron or filesystem types.

import {
  DEFAULT_HARNESS_ID,
  DEFAULT_LAUNCH_BYPASS_PERMISSIONS,
  DEFAULT_LAUNCH_MAX_CONCURRENT,
  DEFAULT_MESSAGE_DIRECT_ROUTES,
  DEFAULT_MESSAGE_LOOP_CAP,
  DEFAULT_PARENT_REPLY_TIMEOUT_MINUTES,
  MESSAGE_DIRECT_ROUTES,
} from "./model.js";
import type { JsonSchema } from "./rules.js";

/** Settings page sections, most used first (decision S7). */
export type SettingSectionId =
  | "general"
  | "agents"
  | "code-review"
  | "github"
  | "inbox";

/**
 * Value kinds. `harness` is a string that must name a registered agent
 * (built-in or `agents.custom[]`); `enum` a string out of `values`.
 */
export type SettingType = "boolean" | "integer" | "string" | "enum" | "harness";

/** A setting's value as stored in config.json. */
export type SettingValue = boolean | number | string;

/** One UI-exposed setting. */
export interface SettingDescription {
  /** Dotted key path in config.json (e.g. `launch.maxConcurrent`). */
  key: string;
  type: SettingType;
  /**
   * The value in effect when the key is absent; `null` when absence means
   * "no value" (e.g. `launch.defaultModel`: the agent's own default).
   */
  default: SettingValue | null;
  title: string;
  help: string;
  section: SettingSectionId;
  /** `integer`: inclusive bounds. */
  min?: number;
  max?: number;
  /** `enum`: the allowed values. */
  values?: readonly string[];
  /** `enum`: display label per value (a value without one shows as itself). */
  valueLabels?: Readonly<Record<string, string>>;
  /** `string`: whether `""` is a valid value (otherwise it must be non-empty once trimmed). */
  allowEmpty?: boolean;
  /** Display unit of a stored number (the UI may convert, e.g. ms shown as minutes). */
  unit?: "ms" | "minutes";
  /** Shown read-only on the Settings page (changed elsewhere, e.g. `automation` on the Rules page, S13). */
  uiReadOnly?: boolean;
  /** Not given a control; the Settings page offers "Edit in config.json" (S1). */
  fileOnly?: boolean;
}

/** `terminal.fontSize` default (S11). */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
/**
 * `terminal.screenReader` default: off. xterm's screen-reader mirror froze
 * the window for 26 s under a real Pi flood (2026-11-19), and Electron's
 * "accessibility support" signal also fires for apps that are not screen
 * readers, so it is only on when the user turns it on.
 */
export const DEFAULT_TERMINAL_SCREEN_READER = false;

/** `notifications.enabled` default (S11). */
export const DEFAULT_NOTIFICATIONS_ENABLED = true;
/**
 * The github source's settings defaults (`sources.github.settings.*`).
 * engines/sources/github-source.ts applies exactly these, so the Settings
 * page's "changed" markers and reset agree with what the source does.
 */
export const DEFAULT_GITHUB_SEARCH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_GITHUB_WATCH_REVIEW_REQUESTS = false;
export const DEFAULT_GITHUB_WATCH_MENTIONS = false;

/** Every UI-exposed setting that maps to a config key ("Settings in v1"). */
export const SETTINGS_DESCRIPTION: readonly SettingDescription[] = [
  // --- General ---------------------------------------------------------
  {
    key: "codeRoot",
    type: "string",
    default: "~/Code",
    title: "Code folder",
    help: "The folder that holds your repository checkouts. Changing it rediscovers repositories.",
    section: "general",
  },
  {
    key: "branchPrefix",
    type: "string",
    default: "",
    allowEmpty: true,
    title: "Branch prefix",
    help: 'Namespace for branches Harbormaster creates, e.g. "alice/". Leave empty for none.',
    section: "general",
  },
  {
    key: "terminal.fontSize",
    type: "integer",
    default: DEFAULT_TERMINAL_FONT_SIZE,
    min: 8,
    max: 32,
    title: "Terminal font size",
    help: "Font size of task terminals, in points. Applies to open panes immediately.",
    section: "general",
  },
  {
    key: "terminal.screenReader",
    type: "boolean",
    default: DEFAULT_TERMINAL_SCREEN_READER,
    title: "Screen-reader support for terminals",
    help: "Keeps a copy of terminal text that screen readers such as VoiceOver can read. Turn it on only if you use one: it can slow down busy agent panes.",
    section: "general",
  },
  {
    key: "notifications.enabled",
    type: "boolean",
    default: DEFAULT_NOTIFICATIONS_ENABLED,
    title: "Desktop notifications",
    help: "Show a system notification when a task needs you.",
    section: "general",
  },
  {
    key: "automation",
    type: "boolean",
    default: true,
    uiReadOnly: true,
    title: "Automation",
    help: "Whether board rules run. Managed on the Rules page.",
    section: "general",
  },
  // --- Agents ----------------------------------------------------------
  {
    key: "launch.defaultHarness",
    type: "harness",
    default: DEFAULT_HARNESS_ID,
    title: "Default agent",
    help: "The agent new tasks start with.",
    section: "agents",
  },
  {
    key: "launch.defaultModel",
    type: "string",
    default: null,
    title: "Default model",
    help: "Model for tasks on the default agent. Empty uses the agent's own default.",
    section: "agents",
  },
  {
    key: "launch.bypassPermissions",
    type: "boolean",
    default: DEFAULT_LAUNCH_BYPASS_PERMISSIONS,
    title: "Skip permission prompts for launched tasks",
    help: "Tasks started in the background run without asking for permission.",
    section: "agents",
  },
  {
    key: "launch.maxConcurrent",
    type: "integer",
    default: DEFAULT_LAUNCH_MAX_CONCURRENT,
    min: 1,
    max: 64,
    title: "Max tasks running at once",
    help: "Launched tasks beyond this wait in a queue.",
    section: "agents",
  },
  // --- Code review -----------------------------------------------------
  {
    key: "captureAgentBrowser",
    type: "boolean",
    default: false,
    title: "Open agents' local pages in the app",
    help: "Browser opens from agent sessions (dev servers, previews) open in the task's workspace.",
    section: "code-review",
  },
  // --- GitHub & sources ------------------------------------------------
  {
    key: "sources.github.enabled",
    type: "boolean",
    default: true,
    title: "GitHub",
    help: "Watch pull requests of your tasks on GitHub.",
    section: "github",
  },
  {
    key: "sources.github.settings.watchReviewRequests",
    type: "boolean",
    default: DEFAULT_GITHUB_WATCH_REVIEW_REQUESTS,
    title: "Create a task when someone requests my review",
    help: "Look for open pull requests that request your review.",
    section: "github",
  },
  {
    key: "sources.github.settings.watchMentions",
    type: "boolean",
    default: DEFAULT_GITHUB_WATCH_MENTIONS,
    title: "Create a task when a pull request mentions me",
    help: "Look for open pull requests that mention you.",
    section: "github",
  },
  {
    key: "sources.github.settings.searchIntervalMs",
    type: "integer",
    default: DEFAULT_GITHUB_SEARCH_INTERVAL_MS,
    min: 60_000,
    max: 24 * 60 * 60_000,
    unit: "ms",
    title: "Check interval",
    help: "How often to look for review requests and mentions.",
    section: "github",
  },
  // --- Inbox & messaging -----------------------------------------------
  {
    key: "messaging.parentReplyTimeoutMinutes",
    type: "integer",
    default: DEFAULT_PARENT_REPLY_TIMEOUT_MINUTES,
    min: 1,
    max: 24 * 60,
    unit: "minutes",
    title: "Parent reply timeout",
    help: "How long a subtask's question may wait on its parent before it is flagged.",
    section: "inbox",
  },
  {
    key: "messaging.loopCap",
    type: "integer",
    default: DEFAULT_MESSAGE_LOOP_CAP,
    min: 1,
    max: 100,
    title: "Message loop cap",
    help: "How many messages any two tasks talking directly may exchange on their own before you are asked.",
    section: "inbox",
  },
  {
    key: "messaging.directRoutes",
    type: "enum",
    default: DEFAULT_MESSAGE_DIRECT_ROUTES,
    values: MESSAGE_DIRECT_ROUTES,
    valueLabels: {
      "parent-and-child": "Parent and child",
      "same-task-tree": "Same task tree",
      "any-task": "Any task",
    },
    title: "Messages between tasks",
    help: "Which tasks may message each other without asking you. A task and its parent always can; anything else waits for your approval. You can also allow one pair both ways when you approve a message.",
    section: "inbox",
  },
  {
    key: "inbox.priorityFilter",
    type: "string",
    default: null,
    fileOnly: true,
    title: "Priority filter",
    help: "A CEL expression deciding which inbox items are Priority.",
    section: "inbox",
  },
];

/** `updateSettings` input: key path → new value, or `null` to reset (remove the key). */
export type SettingsPatch = Record<string, SettingValue | null>;

/** A problem with config.json (syntax or a rejected value). */
export interface ConfigFileError {
  /** Human-readable problem, without the file path (e.g. "launch.loopCap must be a positive integer"). */
  message: string;
  /** 1-based line, when known (JSON syntax errors). */
  line?: number;
  /** 1-based column, when known. */
  column?: number;
}

/** A selectable agent for `harness`-typed settings. */
export interface SettingsHarnessOption {
  id: string;
  label: string;
  custom: boolean;
}

/**
 * One registered event source as the Settings page sees it (S10): built-in
 * or from an add-on, its on/off state and its `settings` with the JSON
 * Schema they are checked against. Written through `updateSettings` with
 * the keys `sources.<id>.enabled` and `sources.<id>.settings.<property>`.
 */
export interface SettingsSource {
  id: string;
  /** The source's `title`, else its id. */
  label: string;
  /** Shipped with Harbormaster (`harbormaster`, `github`, `version-endpoint`). */
  builtin: boolean;
  /** The add-on providing it (absent for built-ins). */
  addon?: { name: string; description?: string };
  /** `sources.<id>.enabled !== false`. */
  enabled: boolean;
  /** `sources.<id>.enabled` is set in config.json. */
  enabledExplicit: boolean;
  /** JSON Schema for `settings` (properties may carry `title` / `description` / `default`). */
  settingsSchema?: JsonSchema;
  /** `sources.<id>.settings` as configured (empty when unset). */
  settings: Record<string, unknown>;
  /** Property names set in `sources.<id>.settings` (changed markers + reset). */
  explicit: string[];
  /** The configured settings fail the schema: the source is off until fixed. */
  problems: string[];
}

/** `CoreCommands.getSettings`: everything the Settings page reads. */
export interface SettingsSnapshot {
  description: readonly SettingDescription[];
  /** Effective value per described key (explicit, else the default; `null` = none). */
  values: Record<string, SettingValue | null>;
  /** Described keys present in config.json (S12 "changed" markers pair with reset). */
  explicit: string[];
  /** Per-repository overrides of global settings (S8): key → number of repositories. */
  overriddenIn: Record<string, number>;
  /** Choices for `harness`-typed settings (built-ins, then custom agents). */
  harnesses: SettingsHarnessOption[];
  /** Every registered event source (built-ins, then loaded add-ons), S10. */
  sources: SettingsSource[];
  /** config.json currently fails to load; values are the last good config's (S4). */
  error?: ConfigFileError;
}
