// Pure helpers for the new-task DRAFT (renderer-only state; core never sees an
// unsubmitted task — AGENTS.md "core is headless"). Same `StorageLike`-threaded,
// window-free pattern as lib/workspace-persistence.ts so it is unit-testable
// under plain vitest. App.tsx owns the single draft; NewTaskComposer edits it.

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const NEW_TASK_DRAFT_KEY = "harbormaster.newTaskDraft";

/** "" = no repository chosen yet; otherwise a repository id, or `CLONE_URL_VALUE` (launch mode only). */
export const SCRATCH_VALUE = "";
export const CLONE_URL_VALUE = "__clone-url__";

/**
 * The composer's Task / Chat toggle (cf. Claude Desktop's Chat vs Code,
 * Codex's Local vs Worktree): `task` = repository-backed work with its own
 * branch + worktree (a repository is required); `chat` = no repository, pi
 * runs in a scratch directory. The repository picker only exists in `task`
 * mode, and a chosen repository is ignored in `chat` mode.
 */
export type DraftMode = "task" | "chat";

/** Where a submitted draft runs, or `null` when task mode still lacks a repository. */
export type DraftRepository =
  | { none: true }
  | { cloneUrl: string }
  | { repositoryId: string };

export function draftRepository(draft: {
  mode: DraftMode;
  repositoryId: string;
  cloneUrl: string;
}): DraftRepository | null {
  if (draft.mode === "chat") return { none: true };
  if (draft.repositoryId === CLONE_URL_VALUE) {
    const cloneUrl = draft.cloneUrl.trim();
    return cloneUrl ? { cloneUrl } : null;
  }
  if (draft.repositoryId === SCRATCH_VALUE) return null;
  return { repositoryId: draft.repositoryId };
}

/** `none` = plain create (Start / Park in backlog); the others launch in the background. */
export type DraftLink = "none" | "child" | "standalone";

export interface NewTaskDraft {
  title: string;
  prompt: string;
  mode: DraftMode;
  repositoryId: string;
  link: DraftLink;
  /** The task that was focused when the draft was opened (never the draft itself). */
  originTaskId: string | null;
  cloneUrl: string;
  baseBranch: "default" | "parent";
  model: string;
}

export function emptyDraft(originTaskId: string | null = null): NewTaskDraft {
  return {
    title: "",
    prompt: "",
    mode: "task",
    repositoryId: SCRATCH_VALUE,
    link: "none",
    originTaskId,
    cloneUrl: "",
    baseBranch: "default",
    model: "",
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

/** Whether closing the draft needs a discard confirmation (origin alone does not count). */
export function isDraftEmpty(draft: NewTaskDraft): boolean {
  return (
    draft.title.trim() === "" &&
    draft.prompt.trim() === "" &&
    draft.repositoryId === SCRATCH_VALUE &&
    draft.link === "none" &&
    draft.cloneUrl.trim() === "" &&
    draft.model.trim() === ""
  );
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

/** Tolerant parse: bad JSON / wrong shape → `null`; unknown/missing fields fall back to defaults. */
export function parseDraft(raw: string | null): NewTaskDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const v = value as Record<string, unknown>;
    const str = (key: string): string =>
      typeof v[key] === "string" ? (v[key] as string) : "";
    const link =
      v.link === "child" || v.link === "standalone" ? v.link : "none";
    const origin =
      typeof v.originTaskId === "string" && v.originTaskId
        ? v.originTaskId
        : null;
    return {
      title: str("title"),
      prompt: str("prompt"),
      mode: v.mode === "chat" ? "chat" : "task",
      repositoryId: str("repositoryId"),
      link,
      originTaskId: origin,
      cloneUrl: str("cloneUrl"),
      baseBranch: v.baseBranch === "parent" ? "parent" : "default",
      model: str("model"),
    };
  } catch {
    return null;
  }
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
