// Pure helpers for the new-task DRAFT (renderer-only state; core never sees an
// unsubmitted task — AGENTS.md "core is headless"). Same `StorageLike`-threaded,
// window-free pattern as lib/workspace-persistence.ts so it is unit-testable
// under plain vitest. App.tsx owns the single draft; NewTaskComposer edits it.
// Design record: /docs/new-task-composer.md.

import type {
  CreateTaskInput,
  LaunchTaskInput,
  Task,
  ThinkingLevel,
} from "../../../preload/api";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const NEW_TASK_DRAFT_KEY = "harbormaster.newTaskDraft";
export const NEW_TASK_PREFS_KEY = "harbormaster.newTaskPrefs";

/**
 * Where the task runs, as one serializable token (the composer's Where
 * picker, which replaced the Task / Chat toggle):
 *
 * - `""`: nothing chosen yet (submit is blocked)
 * - `repo:<repositoryId>`: its own branch + worktree
 * - `folder:<path>`: a registered folder (core decides git worktree vs. in place)
 * - `clone`: clone `draft.cloneUrl` first
 * - `none`: no folder, pi runs in a scratch directory ("chat")
 */
export type WhereToken = string;

export const WHERE_UNSET = "";
export const WHERE_NONE = "none";
export const WHERE_CLONE = "clone";

export function repoWhere(repositoryId: string): WhereToken {
  return `repo:${repositoryId}`;
}

export function folderWhere(path: string): WhereToken {
  return `folder:${path}`;
}

export type ParsedWhere =
  | { kind: "unset" }
  | { kind: "repository"; repositoryId: string }
  | { kind: "folder"; path: string }
  | { kind: "clone" }
  | { kind: "none" };

export function parseWhere(token: WhereToken): ParsedWhere {
  if (token === WHERE_NONE) return { kind: "none" };
  if (token === WHERE_CLONE) return { kind: "clone" };
  if (token.startsWith("repo:") && token.length > 5) {
    return { kind: "repository", repositoryId: token.slice(5) };
  }
  if (token.startsWith("folder:") && token.length > 7) {
    return { kind: "folder", path: token.slice(7) };
  }
  return { kind: "unset" };
}

/** What the split submit button does (see /docs/new-task-composer.md "Submit"). */
export type SubmitAction = "start" | "background" | "park";

export interface NewTaskDraft {
  title: string;
  prompt: string;
  where: WhereToken;
  /** Only used while `where === "clone"`. */
  cloneUrl: string;
  /** Explicit parent (the `+ Parent` picker); never pre-filled. */
  parentTaskId: string | null;
  /** The task that was focused when the draft was opened: first parent suggestion, default Where. Never the draft itself. */
  originTaskId: string | null;
  /** Harness id; "" = the default harness. */
  harness: string;
  /** Model id; "" = the harness/config default. */
  model: string;
  /** "" = the harness default. */
  thinking: ThinkingLevel | "";
  /** Explicit base ref; `null` = smart default (parent's branch for a same-repo child, else the default branch). */
  baseRef: string | null;
  /** Temp image paths pasted into the prompt; core copies the ones still referenced at submit. */
  attachments: string[];
}

/** Sticky composer choices, remembered across drafts. */
export interface NewTaskPrefs {
  where: WhereToken;
  harness: string;
  model: string;
  thinking: ThinkingLevel | "";
  /** Most recent Where tokens first (deduplicated, capped). */
  recents: WhereToken[];
}

const MAX_RECENTS = 5;

export function emptyPrefs(): NewTaskPrefs {
  return {
    where: WHERE_UNSET,
    harness: "",
    model: "",
    thinking: "",
    recents: [],
  };
}

/** The Where a task itself runs in, as a token (for "default to the focused task's repo"). */
export function taskWhere(
  task: Pick<Task, "repositoryId" | "folderPath">,
): WhereToken {
  if (task.repositoryId) return repoWhere(task.repositoryId);
  if (task.folderPath) return folderWhere(task.folderPath);
  return WHERE_UNSET;
}

/**
 * A fresh draft: Where defaults to the origin task's location, else the last
 * one used; the agent choice is the last one used. Parent is never
 * pre-filled (manual drafts are almost always standalone).
 */
export function emptyDraft(
  origin: Pick<Task, "id" | "repositoryId" | "folderPath"> | null = null,
  prefs: NewTaskPrefs = emptyPrefs(),
): NewTaskDraft {
  const originWhere = origin ? taskWhere(origin) : WHERE_UNSET;
  return {
    title: "",
    prompt: "",
    where: originWhere || prefs.where,
    cloneUrl: "",
    parentTaskId: null,
    originTaskId: origin?.id ?? null,
    harness: prefs.harness,
    model: prefs.model,
    thinking: prefs.thinking,
    baseRef: null,
    attachments: [],
  };
}

/** Prefs after a successful submit: remember the agent choice and Where, bump recents. */
export function rememberDraft(
  prefs: NewTaskPrefs,
  draft: NewTaskDraft,
): NewTaskPrefs {
  const where = draft.where === WHERE_CLONE ? prefs.where : draft.where;
  const recents =
    where && where !== WHERE_NONE
      ? [where, ...prefs.recents.filter((token) => token !== where)].slice(
          0,
          MAX_RECENTS,
        )
      : prefs.recents;
  return {
    where,
    harness: draft.harness,
    model: draft.model,
    thinking: draft.thinking,
    recents,
  };
}

const MAX_DERIVED_TITLE = 60;

/** First non-empty line of the prompt, truncated at a word boundary with an ellipsis. */
export function deriveTitle(prompt: string): string {
  const line =
    prompt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (line.length <= MAX_DERIVED_TITLE) return line;
  const cut = line.slice(0, MAX_DERIVED_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  const base = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(
    /[\s.,;:!?-]+$/,
    "",
  );
  return `${base}\u2026`;
}

/** Trimmed title, else the title derived from the prompt ("" when both are empty). */
export function effectiveTitle(draft: {
  title: string;
  prompt: string;
}): string {
  return draft.title.trim() || deriveTitle(draft.prompt);
}

/** Sidebar row label: live/derived title, or "New task" when nothing is typed. */
export function draftLabel(draft: { title: string; prompt: string }): string {
  return effectiveTitle(draft) || "New task";
}

/**
 * Whether closing the draft needs a discard confirmation. Where and the
 * agent choice are prefilled defaults, so they never count on their own.
 */
export function isDraftEmpty(draft: NewTaskDraft): boolean {
  return (
    draft.title.trim() === "" &&
    draft.prompt.trim() === "" &&
    draft.parentTaskId === null &&
    draft.cloneUrl.trim() === ""
  );
}

/** The default submit action: a draft with a parent runs in the background, anything else starts and opens. */
export function defaultAction(
  draft: Pick<NewTaskDraft, "parentTaskId">,
): SubmitAction {
  return draft.parentTaskId ? "background" : "start";
}

/** ⌥⌘↵: the other of Start / Run in background. */
export function alternateAction(
  draft: Pick<NewTaskDraft, "parentTaskId">,
): SubmitAction {
  return defaultAction(draft) === "start" ? "background" : "start";
}

/**
 * The base ref a submit would use: the explicit pick, else the parent's
 * branch for a child in the parent's repository, else `undefined` (the
 * repository's default branch).
 */
export function effectiveBaseRef(
  draft: Pick<NewTaskDraft, "baseRef" | "where">,
  parent: Pick<Task, "repositoryId" | "branch"> | null,
): string | undefined {
  if (draft.baseRef) return draft.baseRef;
  const where = parseWhere(draft.where);
  if (
    where.kind === "repository" &&
    parent?.branch &&
    parent.repositoryId === where.repositoryId
  ) {
    return parent.branch;
  }
  return undefined;
}

/** Why the draft can't be submitted with `action` yet, or `null` when it can. */
export function submitBlocker(
  draft: NewTaskDraft,
  action: SubmitAction,
): string | null {
  if (!effectiveTitle(draft)) return "Add a title or a prompt";
  const where = parseWhere(draft.where);
  if (where.kind === "unset") return "Choose where it runs";
  if (where.kind === "clone" && !draft.cloneUrl.trim()) {
    return "Enter a clone URL";
  }
  if (action === "background" && !draft.prompt.trim()) {
    return "A background run needs a prompt";
  }
  return null;
}

export type SubmitPlan =
  | { command: "createTask"; input: CreateTaskInput }
  | { command: "launchTask"; input: LaunchTaskInput };

/**
 * Turn a submittable draft into the one core command it maps to: Start and
 * Park are `createTask` (with or without `start`), Run in background is
 * `launchTask` (a `child` when a parent is set, else `standalone`). Assumes
 * `submitBlocker(draft, action) === null`.
 */
export function planSubmit(
  draft: NewTaskDraft,
  action: SubmitAction,
  parent: Pick<Task, "id" | "repositoryId" | "branch"> | null,
): SubmitPlan {
  const where = parseWhere(draft.where);
  const title = effectiveTitle(draft);
  const prompt = draft.prompt.trim();
  // Only a known repository has branches to pick; a clone or folder
  // branches off its default branch.
  const baseRef =
    where.kind === "repository" ? effectiveBaseRef(draft, parent) : undefined;
  const attachments = draft.attachments.filter((path) =>
    draft.prompt.includes(path),
  );
  const agent = {
    ...(draft.harness ? { harness: draft.harness } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(attachments.length ? { attachments } : {}),
  };

  if (action === "background") {
    const repository: LaunchTaskInput["repository"] =
      where.kind === "repository"
        ? { repositoryId: where.repositoryId }
        : where.kind === "folder"
          ? { folderPath: where.path }
          : where.kind === "clone"
            ? { cloneUrl: draft.cloneUrl.trim() }
            : { none: true };
    const stacksOnParent = !!parent && !!baseRef && baseRef === parent.branch;
    return {
      command: "launchTask",
      input: {
        relation: parent ? "child" : "standalone",
        ...(parent ? { fromTaskId: parent.id } : {}),
        title,
        prompt,
        repository,
        ...(stacksOnParent
          ? { baseBranch: "parent" as const }
          : baseRef
            ? { baseRef }
            : {}),
        ...agent,
      },
    };
  }

  return {
    command: "createTask",
    input: {
      title,
      initialPrompt: prompt ? draft.prompt : "",
      ...(where.kind === "repository"
        ? { repositoryId: where.repositoryId }
        : {}),
      ...(where.kind === "folder" ? { folderPath: where.path } : {}),
      ...(where.kind === "clone" ? { cloneUrl: draft.cloneUrl.trim() } : {}),
      ...(parent ? { parentTaskId: parent.id } : {}),
      ...(baseRef ? { baseRef } : {}),
      ...(action === "start" ? { start: true } : {}),
      ...agent,
    },
  };
}

/**
 * Lowercase, hyphenated preview slug — mirrors (but need not match
 * byte-for-byte) @harbormaster/core's `engines/task-workspace.ts slugify()`.
 */
export function previewSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}

export function serializeDraft(draft: NewTaskDraft): string {
  return JSON.stringify(draft);
}

const THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function record(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(v: Record<string, unknown>, key: string): string {
  return typeof v[key] === "string" ? (v[key] as string) : "";
}

function thinkingField(v: Record<string, unknown>): ThinkingLevel | "" {
  return THINKING.has(v.thinking as string)
    ? (v.thinking as ThinkingLevel)
    : "";
}

/**
 * Tolerant parse: bad JSON / wrong shape → `null`; unknown/missing fields
 * fall back to defaults. A draft saved by the old composer (Task / Chat
 * mode + `repositoryId`) maps onto `where`.
 */
export function parseDraft(raw: string | null): NewTaskDraft | null {
  const v = record(raw);
  if (!v) return null;
  let where = stringField(v, "where");
  if (!where && "mode" in v) {
    const legacyRepo = stringField(v, "repositoryId");
    where =
      v.mode === "chat"
        ? WHERE_NONE
        : legacyRepo === "__clone-url__"
          ? WHERE_CLONE
          : legacyRepo
            ? repoWhere(legacyRepo)
            : WHERE_UNSET;
  }
  const id = (key: string): string | null => stringField(v, key) || null;
  return {
    title: stringField(v, "title"),
    prompt: stringField(v, "prompt"),
    where,
    cloneUrl: stringField(v, "cloneUrl"),
    parentTaskId: id("parentTaskId"),
    originTaskId: id("originTaskId"),
    harness: stringField(v, "harness"),
    model: stringField(v, "model"),
    thinking: thinkingField(v),
    baseRef: id("baseRef"),
    attachments: Array.isArray(v.attachments)
      ? v.attachments.filter((path): path is string => typeof path === "string")
      : [],
  };
}

export function readDraft(storage: StorageLike): NewTaskDraft | null {
  try {
    return parseDraft(storage.getItem(NEW_TASK_DRAFT_KEY));
  } catch {
    return null;
  }
}

/** Persists the draft, or forgets it when `null`. */
export function storeDraft(
  storage: StorageLike,
  draft: NewTaskDraft | null,
): void {
  try {
    if (draft === null) storage.removeItem(NEW_TASK_DRAFT_KEY);
    else storage.setItem(NEW_TASK_DRAFT_KEY, serializeDraft(draft));
  } catch {
    // Storage unavailable/full: this session just won't persist it.
  }
}

export function readPrefs(storage: StorageLike): NewTaskPrefs {
  let v: Record<string, unknown> | null = null;
  try {
    v = record(storage.getItem(NEW_TASK_PREFS_KEY));
  } catch {
    v = null;
  }
  if (!v) return emptyPrefs();
  return {
    where: stringField(v, "where"),
    harness: stringField(v, "harness"),
    model: stringField(v, "model"),
    thinking: thinkingField(v),
    recents: Array.isArray(v.recents)
      ? v.recents
          .filter((token): token is string => typeof token === "string")
          .slice(0, MAX_RECENTS)
      : [],
  };
}

export function storePrefs(storage: StorageLike, prefs: NewTaskPrefs): void {
  try {
    storage.setItem(NEW_TASK_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable/full: prefs just won't stick.
  }
}
