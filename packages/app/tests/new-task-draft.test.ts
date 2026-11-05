import { describe, expect, it } from "vitest";
import {
  CLONE_URL_VALUE,
  deriveTitle,
  draftLabel,
  draftRepository,
  effectiveTitle,
  emptyDraft,
  isDraftEmpty,
  NEW_TASK_DRAFT_KEY,
  parseDraft,
  readDraft,
  serializeDraft,
  storeDraft,
} from "../src/renderer/src/lib/new-task-draft";
import { prependToOrder } from "../src/renderer/src/lib/sidebar-order";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("deriveTitle", () => {
  it("uses the first non-empty line", () => {
    expect(deriveTitle("\n  \n  Fix the login bug  \nmore")).toBe(
      "Fix the login bug",
    );
  });
  it("returns empty for blank prompts", () => {
    expect(deriveTitle("  \n ")).toBe("");
  });
  it("truncates long lines at a word boundary with an ellipsis", () => {
    const out = deriveTitle(
      "Refactor the authentication middleware so that sessions expire correctly after logout",
    );
    expect(out.endsWith("\u2026")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out).toBe(
      "Refactor the authentication middleware so that sessions\u2026",
    );
  });
});

describe("effectiveTitle / draftLabel", () => {
  it("prefers the typed title", () => {
    expect(effectiveTitle({ title: " Mine ", prompt: "x" })).toBe("Mine");
  });
  it("falls back to the derived title then 'New task'", () => {
    expect(draftLabel({ title: "", prompt: "do it\nnow" })).toBe("do it");
    expect(draftLabel({ title: "", prompt: "" })).toBe("New task");
  });
});

describe("isDraftEmpty", () => {
  it("ignores the origin alone", () => {
    expect(isDraftEmpty(emptyDraft("t1"))).toBe(true);
  });
  it("is non-empty with any field or a link", () => {
    expect(isDraftEmpty({ ...emptyDraft(), prompt: "x" })).toBe(false);
    expect(isDraftEmpty({ ...emptyDraft(), repositoryId: "r" })).toBe(false);
    expect(isDraftEmpty({ ...emptyDraft("t"), link: "child" })).toBe(false);
  });
  it("does not count the Task / Chat toggle alone", () => {
    expect(isDraftEmpty({ ...emptyDraft(), mode: "chat" })).toBe(true);
  });
});

describe("draftRepository", () => {
  const base = { mode: "task" as const, repositoryId: "", cloneUrl: "" };
  it("task mode needs a repository (or a non-blank clone URL)", () => {
    expect(draftRepository(base)).toBeNull();
    expect(
      draftRepository({ ...base, repositoryId: "github.com/a/b" }),
    ).toEqual({ repositoryId: "github.com/a/b" });
    expect(
      draftRepository({
        ...base,
        repositoryId: CLONE_URL_VALUE,
        cloneUrl: " ",
      }),
    ).toBeNull();
    expect(
      draftRepository({
        ...base,
        repositoryId: CLONE_URL_VALUE,
        cloneUrl: " https://x/y.git ",
      }),
    ).toEqual({ cloneUrl: "https://x/y.git" });
  });
  it("chat mode never uses a repository, even a previously chosen one", () => {
    expect(
      draftRepository({
        ...base,
        mode: "chat",
        repositoryId: "github.com/a/b",
      }),
    ).toEqual({ none: true });
  });
});

describe("draft persistence", () => {
  it("round-trips", () => {
    const draft = {
      ...emptyDraft("t1"),
      title: "A",
      prompt: "B",
      mode: "chat" as const,
      link: "child" as const,
    };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });
  it("tolerates garbage", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("{nope")).toBeNull();
    expect(parseDraft("[1]")).toBeNull();
    expect(parseDraft('{"link":"weird","title":3}')).toEqual(emptyDraft());
  });
  it("stores and forgets", () => {
    const storage = memoryStorage();
    storeDraft(storage, { ...emptyDraft(), prompt: "p" });
    expect(readDraft(storage)?.prompt).toBe("p");
    storeDraft(storage, null);
    expect(storage.map.has(NEW_TASK_DRAFT_KEY)).toBe(false);
    expect(readDraft(storage)).toBeNull();
  });
});

describe("prependToOrder", () => {
  it("moves or inserts at the front", () => {
    expect(prependToOrder(["a", "b"], "c")).toEqual(["c", "a", "b"]);
    expect(prependToOrder(["a", "b"], "b")).toEqual(["b", "a"]);
    const same = ["a"];
    expect(prependToOrder(same, "a")).toBe(same);
  });
});
