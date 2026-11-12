// Pure helpers for the new-task DRAFT (renderer-only state; core never sees an
// unsubmitted task — AGENTS.md "core is headless"). Same `StorageLike`-threaded,
// window-free pattern as lib/workspace-persistence.ts so it is unit-testable
// under plain vitest. App.tsx owns the single draft; NewTaskComposer edits it.
// Design record: /docs/new-task-composer.md.

import type {
  CreateTaskInput,
  LaunchTaskInput,
  PullRequestPreview,
  PullRequestRole,
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

/**
 * The composer's Task / Review / Chat switch: `task` gets its own branch +
 * worktree (for a repository); `review` binds the task to a pull request
 * (pasted URL) and checks out its head; `chat` never creates a worktree. A
 * chat with a repository runs in that repository's checkout, for questions
 * with the repo as context.
 */
export type DraftMode = "task" | "review" | "chat";

const MODES: readonly DraftMode[] = ["task", "review", "chat"];

function modeField(value: unknown): DraftMode {
  return MODES.includes(value as DraftMode) ? (value as DraftMode) : "task";
}

/**
 * The composer's lookup of `draft.prUrl` (`previewPullRequest`): still
 * resolving, failed (bad URL, unknown repository, GitHub unreachable), or
 * the PR's card facts. `null` = no URL to look up.
 */
export type PrLookup =
  | { status: "resolving" }
  | { status: "error"; message: string }
  | { status: "resolved"; pr: PullRequestPreview };

/** What the split submit button does (see /docs/new-task-composer.md "Submit"). */
export type SubmitAction = "start" | "background" | "park";

export interface NewTaskDraft {
  title: string;
  prompt: string;
  mode: DraftMode;
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
  /**
   * Run in background only (decision R7): whether the launched agent skips
   * its permission prompts. `null` = the repository / app default. Never
   * sticky: every draft starts on the default.
   */
  bypassPermissions: boolean | null;
  /**
   * A pull request to work on (`https://github.com/org/repo/pull/12`): the
   * task binds to it and checks out its head branch. Used in Review mode,
   * and in Task mode once "Attach a PR…" is used. "" = none.
   */
  prUrl: string;
  /**
   * Review mode's `Author | Reviewer` override; "" = from GitHub (the viewer
   * authored it → author, else reviewer). Task mode is always author. A
   * reviewer task never pushes or opens a PR.
   */
  prRole: PullRequestRole | "";
}

/** Sticky composer choices, remembered across drafts. */
export interface NewTaskPrefs {
  mode: DraftMode;
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
    mode: "task",
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
    // Always opens on Task; Chat is a per-draft choice, never sticky.
    mode: "task",
    where: originWhere || prefs.where,
    cloneUrl: "",
    parentTaskId: null,
    originTaskId: origin?.id ?? null,
    harness: prefs.harness,
    model: prefs.model,
    thinking: prefs.thinking,
    baseRef: null,
    attachments: [],
    bypassPermissions: null,
    prUrl: "",
    prRole: "",
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
    mode: draft.mode,
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
    draft.cloneUrl.trim() === "" &&
    draft.prUrl.trim() === ""
  );
}

/**
 * Whether a submit binds the task to `draft.prUrl`: always in Review mode
 * (the URL is required), in Task mode only once a URL was attached, never
 * in Chat mode.
 */
export function usesPullRequest(
  draft: Pick<NewTaskDraft, "mode" | "prUrl">,
): boolean {
  return (
    draft.mode === "review" ||
    (draft.mode === "task" && draft.prUrl.trim() !== "")
  );
}

/**
 * The role a PR-bound submit sends: Review mode's explicit pick, else from
 * the PR (`viewerIsAuthor` → author, anything else → reviewer); Task mode's
 * "Attach a PR…" is always the author continuing their own PR.
 */
export function effectivePrRole(
  draft: Pick<NewTaskDraft, "mode" | "prRole">,
  pr: Pick<PullRequestPreview, "viewerIsAuthor"> | null | undefined,
): PullRequestRole {
  if (draft.mode !== "review") return "author";
  if (draft.prRole) return draft.prRole;
  return pr?.viewerIsAuthor ? "author" : "reviewer";
}

/**
 * The title a submit uses: the typed one, else (Review mode) the PR's own
 * title (`Review: <title>` for a reviewer; the prompt there is review
 * focus, not a name), else the prompt's first line, else (an attached PR)
 * the PR's title.
 */
export function submitTitle(
  draft: NewTaskDraft,
  pr?: PullRequestPreview | null,
): string {
  if (!pr || !usesPullRequest(draft)) return effectiveTitle(draft);
  const name = pr.title ?? `#${pr.number}`;
  const prTitle =
    effectivePrRole(draft, pr) === "reviewer" ? `Review: ${name}` : name;
  if (draft.mode === "review") return draft.title.trim() || prTitle;
  return effectiveTitle(draft) || prTitle;
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
  draft: Pick<NewTaskDraft, "baseRef" | "where" | "mode">,
  parent: Pick<Task, "repositoryId" | "branch"> | null,
): string | undefined {
  // A chat never creates a branch.
  if (draft.mode === "chat") return undefined;
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

/**
 * Why the draft can't be submitted with `action` yet, or `null` when it can.
 * `pr` is the composer's lookup of `draft.prUrl` (see `PrLookup`). A PR
 * brings its own repository, base and branch, so Where is not needed then,
 * and its title stands in for an empty one.
 */
export function submitBlocker(
  draft: NewTaskDraft,
  action: SubmitAction,
  pr: PrLookup | null = null,
): string | null {
  if (usesPullRequest(draft)) {
    if (!draft.prUrl.trim()) return "Paste a pull request URL";
    if (!pr || pr.status === "resolving") return "Checking the pull request";
    if (pr.status === "error") return "Fix the pull request URL";
    if (!submitTitle(draft, pr.pr)) return "Add a title or a prompt";
    if (action === "background") {
      return "A PR task starts or parks (no background run)";
    }
    return null;
  }
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
  pr: PullRequestPreview | null = null,
): SubmitPlan {
  // A PR task (Review mode, or Task mode's "Attach a PR…"): the same
  // `createTask` + `pullRequest` + `role` the inbox's "Create review task"
  // ends in. Bound to the PR in its own repository, on its head branch
  // (core checks it out); a reviewer never pushes or opens a PR.
  if (pr && usesPullRequest(draft) && action !== "background") {
    const prompt = draft.prompt.trim();
    const attachments = draft.attachments.filter((path) =>
      draft.prompt.includes(path),
    );
    return {
      command: "createTask",
      input: {
        title: submitTitle(draft, pr),
        initialPrompt: prompt ? draft.prompt : "",
        repositoryId: pr.repositoryId,
        pullRequest: pr.number,
        role: effectivePrRole(draft, pr),
        ...(parent ? { parentTaskId: parent.id } : {}),
        ...(action === "start" ? { start: true } : {}),
        ...(draft.harness ? { harness: draft.harness } : {}),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.thinking ? { thinking: draft.thinking } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
    };
  }
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
  // Chat: no worktree; a repository (or clone) runs in its own checkout.
  const inPlace =
    draft.mode === "chat" &&
    (where.kind === "repository" || where.kind === "clone");
  const agent = {
    ...(inPlace ? { inPlace: true } : {}),
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
        ...(draft.bypassPermissions !== null
          ? { bypassPermissions: draft.bypassPermissions }
          : {}),
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
  if (!where && "repositoryId" in v) {
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
    mode: modeField(v.mode),
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
    bypassPermissions:
      typeof v.bypassPermissions === "boolean" ? v.bypassPermissions : null,
    prUrl: stringField(v, "prUrl"),
    prRole: v.prRole === "author" || v.prRole === "reviewer" ? v.prRole : "",
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
    mode: modeField(v.mode),
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
