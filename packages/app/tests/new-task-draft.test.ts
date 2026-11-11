import { describe, expect, it } from "vitest";
import {
  alternateAction,
  defaultAction,
  deriveTitle,
  draftLabel,
  effectiveTitle,
  emptyDraft,
  emptyPrefs,
  folderWhere,
  isDraftEmpty,
  NEW_TASK_DRAFT_KEY,
  NEW_TASK_PREFS_KEY,
  parseDraft,
  parseWhere,
  planSubmit,
  readDraft,
  readPrefs,
  rememberDraft,
  repoWhere,
  serializeDraft,
  storeDraft,
  storePrefs,
  submitBlocker,
  WHERE_CLONE,
  WHERE_NONE,
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
  it("ignores the origin and the prefilled Where / agent defaults", () => {
    const prefs = {
      ...emptyPrefs(),
      where: repoWhere("github.com/a/b"),
      model: "anthropic/opus",
    };
    expect(isDraftEmpty(emptyDraft({ id: "t1" }, prefs))).toBe(true);
  });
  it("is non-empty with typed text, a parent, or a clone URL", () => {
    expect(isDraftEmpty({ ...emptyDraft(), prompt: "x" })).toBe(false);
    expect(isDraftEmpty({ ...emptyDraft(), parentTaskId: "p" })).toBe(false);
    expect(isDraftEmpty({ ...emptyDraft(), cloneUrl: "https://x" })).toBe(
      false,
    );
  });
});

describe("emptyDraft defaults", () => {
  const prefs = {
    ...emptyPrefs(),
    where: repoWhere("github.com/last/used"),
    harness: "pi",
    model: "anthropic/opus",
    thinking: "high" as const,
  };
  it("defaults Where to the origin task's repository, never pre-filling the parent", () => {
    const draft = emptyDraft(
      { id: "t1", repositoryId: "github.com/focused/repo" },
      prefs,
    );
    expect(draft.where).toBe(repoWhere("github.com/focused/repo"));
    expect(draft.parentTaskId).toBeNull();
    expect(draft.originTaskId).toBe("t1");
    expect(draft).toMatchObject({ model: "anthropic/opus", thinking: "high" });
  });
  it("uses the origin's folder, else the last used Where", () => {
    expect(emptyDraft({ id: "t", folderPath: "/notes" }, prefs).where).toBe(
      folderWhere("/notes"),
    );
    expect(emptyDraft({ id: "t" }, prefs).where).toBe(prefs.where);
    expect(emptyDraft(null, prefs).where).toBe(prefs.where);
  });
});

describe("rememberDraft", () => {
  it("always opens a new draft on Task, even right after a chat", () => {
    const prefs = rememberDraft(emptyPrefs(), {
      ...emptyDraft(),
      mode: "chat",
      where: repoWhere("a"),
    });
    expect(emptyDraft(null, prefs).mode).toBe("task");
    expect(emptyDraft({ id: "t", repositoryId: "a" }, prefs).mode).toBe("task");
  });

  it("keeps the agent choice and Where, with deduplicated capped recents", () => {
    let prefs = emptyPrefs();
    for (const id of ["a", "b", "c", "d", "e", "f", "b"]) {
      prefs = rememberDraft(prefs, {
        ...emptyDraft(),
        where: repoWhere(id),
        model: "m",
      });
    }
    expect(prefs.where).toBe(repoWhere("b"));
    expect(prefs.model).toBe("m");
    expect(prefs.recents).toEqual(
      ["b", "f", "e", "d", "c"].map((id) => repoWhere(id)),
    );
  });
  it("never remembers a clone or 'no folder' as a recent", () => {
    const before = {
      ...emptyPrefs(),
      where: repoWhere("a"),
      recents: [repoWhere("a")],
    };
    const afterClone = rememberDraft(before, {
      ...emptyDraft(),
      where: WHERE_CLONE,
    });
    expect(afterClone.where).toBe(repoWhere("a"));
    expect(afterClone.recents).toEqual([repoWhere("a")]);
    const afterNone = rememberDraft(before, {
      ...emptyDraft(),
      where: WHERE_NONE,
    });
    expect(afterNone.where).toBe(WHERE_NONE);
    expect(afterNone.recents).toEqual([repoWhere("a")]);
  });
});

describe("submit actions", () => {
  const ready = { ...emptyDraft(), prompt: "do it", where: repoWhere("r") };
  it("defaults to Start, or Run in background once a parent is set", () => {
    expect(defaultAction(ready)).toBe("start");
    expect(alternateAction(ready)).toBe("background");
    expect(defaultAction({ ...ready, parentTaskId: "p" })).toBe("background");
    expect(alternateAction({ ...ready, parentTaskId: "p" })).toBe("start");
  });
  it("blocks until there is a title, a Where, a clone URL when cloning, and a prompt for background", () => {
    expect(submitBlocker({ ...ready, prompt: "" }, "start")).toMatch(/title/);
    expect(submitBlocker({ ...ready, where: "" }, "start")).toMatch(/where/);
    expect(
      submitBlocker({ ...ready, where: WHERE_CLONE, cloneUrl: " " }, "start"),
    ).toMatch(/clone URL/);
    expect(
      submitBlocker({ ...ready, title: "T", prompt: "" }, "background"),
    ).toMatch(/prompt/);
    expect(
      submitBlocker({ ...ready, title: "T", prompt: "" }, "park"),
    ).toBeNull();
    expect(submitBlocker(ready, "background")).toBeNull();
  });
});

describe("planSubmit", () => {
  const parent = {
    id: "parent-1",
    repositoryId: "github.com/a/repo",
    branch: "me/parent-branch",
  };
  const ready = {
    ...emptyDraft(),
    title: "Child",
    prompt: "look at /tmp/clipboard-1.png",
    where: repoWhere("github.com/a/repo"),
    model: "anthropic/opus",
    thinking: "high" as const,
    attachments: ["/tmp/clipboard-1.png", "/tmp/removed.png"],
  };

  it("Start / Park create the task, carrying agent fields and only referenced attachments", () => {
    expect(planSubmit(ready, "start", null)).toEqual({
      command: "createTask",
      input: {
        title: "Child",
        initialPrompt: "look at /tmp/clipboard-1.png",
        repositoryId: "github.com/a/repo",
        start: true,
        model: "anthropic/opus",
        thinking: "high",
        attachments: ["/tmp/clipboard-1.png"],
      },
    });
    const park = planSubmit({ ...ready, attachments: [] }, "park", null);
    expect(park.command).toBe("createTask");
    expect(park.input).not.toHaveProperty("start");
  });

  it("only a background run carries the permission switch, and only when set", () => {
    const launched = planSubmit(
      { ...ready, harness: "claude-code", bypassPermissions: false },
      "background",
      null,
    );
    expect(launched.input).toMatchObject({
      harness: "claude-code",
      bypassPermissions: false,
    });
    expect(
      planSubmit({ ...ready, bypassPermissions: true }, "start", null).input,
    ).not.toHaveProperty("bypassPermissions");
    expect(planSubmit(ready, "background", null).input).not.toHaveProperty(
      "bypassPermissions",
    );
  });

  it("a child in its parent's repository stacks on the parent's branch by default", () => {
    const created = planSubmit(ready, "start", parent);
    expect(created.input).toMatchObject({
      parentTaskId: "parent-1",
      baseRef: "me/parent-branch",
    });
    const launched = planSubmit(ready, "background", parent);
    expect(launched).toMatchObject({
      command: "launchTask",
      input: {
        relation: "child",
        fromTaskId: "parent-1",
        repository: { repositoryId: "github.com/a/repo" },
        baseBranch: "parent",
      },
    });
    expect(launched.input).not.toHaveProperty("baseRef");
  });

  it("an explicit base ref wins; another repository never stacks", () => {
    expect(
      planSubmit({ ...ready, baseRef: "release" }, "background", parent).input,
    ).toMatchObject({ baseRef: "release" });
    const elsewhere = planSubmit(
      { ...ready, where: repoWhere("github.com/a/other") },
      "start",
      parent,
    );
    expect(elsewhere.input).not.toHaveProperty("baseRef");
  });

  it("chat never creates a worktree: a repository runs in place, with no base ref even under a parent", () => {
    const chat = { ...ready, mode: "chat" as const };
    const created = planSubmit(chat, "start", parent);
    expect(created.input).toMatchObject({
      repositoryId: "github.com/a/repo",
      inPlace: true,
      parentTaskId: "parent-1",
    });
    expect(created.input).not.toHaveProperty("baseRef");
    const launched = planSubmit(chat, "background", parent);
    expect(launched.input).toMatchObject({
      repository: { repositoryId: "github.com/a/repo" },
      inPlace: true,
    });
    expect(launched.input).not.toHaveProperty("baseBranch");
    // No folder: nothing to run in place.
    expect(
      planSubmit({ ...chat, where: WHERE_NONE }, "start", null).input,
    ).not.toHaveProperty("inPlace");
  });

  it("background without a parent is a standalone launch; folders, clones and chat map to their repository variants", () => {
    expect(
      planSubmit({ ...ready, where: folderWhere("/notes") }, "background", null)
        .input,
    ).toMatchObject({
      relation: "standalone",
      repository: { folderPath: "/notes" },
    });
    expect(
      planSubmit(
        { ...ready, where: WHERE_CLONE, cloneUrl: " https://x/y.git " },
        "background",
        null,
      ).input,
    ).toMatchObject({ repository: { cloneUrl: "https://x/y.git" } });
    expect(
      planSubmit({ ...ready, where: WHERE_NONE }, "background", null).input,
    ).toMatchObject({ repository: { none: true } });
    expect(
      planSubmit({ ...ready, where: folderWhere("/notes") }, "start", null)
        .input,
    ).toMatchObject({ folderPath: "/notes" });
  });
});

describe("parseWhere", () => {
  it("round-trips tokens and treats junk as unset", () => {
    expect(parseWhere(repoWhere("github.com/a/b"))).toEqual({
      kind: "repository",
      repositoryId: "github.com/a/b",
    });
    expect(parseWhere(folderWhere("/x"))).toEqual({
      kind: "folder",
      path: "/x",
    });
    expect(parseWhere(WHERE_NONE)).toEqual({ kind: "none" });
    expect(parseWhere("repo:")).toEqual({ kind: "unset" });
    expect(parseWhere("weird")).toEqual({ kind: "unset" });
  });
});

describe("draft persistence", () => {
  it("round-trips", () => {
    const draft = {
      ...emptyDraft({ id: "t1" }),
      title: "A",
      prompt: "B",
      mode: "chat" as const,
      where: WHERE_NONE,
      parentTaskId: "p",
      thinking: "low" as const,
      baseRef: "dev",
      attachments: ["/tmp/a.png"],
    };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });
  it("tolerates garbage", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("{nope")).toBeNull();
    expect(parseDraft("[1]")).toBeNull();
    expect(parseDraft('{"thinking":"weird","title":3}')).toEqual(emptyDraft());
  });
  it("maps a draft saved by the old Task / Chat composer onto Where", () => {
    expect(
      parseDraft('{"mode":"task","repositoryId":"github.com/a/b"}')?.where,
    ).toBe(repoWhere("github.com/a/b"));
    expect(parseDraft('{"mode":"chat","repositoryId":"x"}')?.where).toBe(
      WHERE_NONE,
    );
  });
  it("stores and forgets", () => {
    const storage = memoryStorage();
    storeDraft(storage, { ...emptyDraft(), prompt: "p" });
    expect(readDraft(storage)?.prompt).toBe("p");
    storeDraft(storage, null);
    expect(storage.map.has(NEW_TASK_DRAFT_KEY)).toBe(false);
    expect(readDraft(storage)).toBeNull();
  });
  it("prefs round-trip and tolerate garbage", () => {
    const storage = memoryStorage();
    expect(readPrefs(storage)).toEqual(emptyPrefs());
    const prefs = { ...emptyPrefs(), model: "m", recents: [repoWhere("a")] };
    storePrefs(storage, prefs);
    expect(readPrefs(storage)).toEqual(prefs);
    storage.setItem(NEW_TASK_PREFS_KEY, "{bad");
    expect(readPrefs(storage)).toEqual(emptyPrefs());
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
