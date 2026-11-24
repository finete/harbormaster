// The four agent-store readers (docs/import.md F1-F5, I17) against the
// recorded fixtures of the real CLIs (scripts/record-import-fixtures.mjs).

import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSessionsReader } from "../src/access/import-claude-sessions-access.js";
import { CodexSessionsReader } from "../src/access/import-codex-sessions-access.js";
import { CursorChatsReader } from "../src/access/import-cursor-chats-access.js";
import { PiSessionsReader } from "../src/access/import-pi-sessions-access.js";
import { materializeFixture } from "./helpers/import-fixtures.js";

const ALL = { since: new Date(0) };
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(harness: string) {
  const made = materializeFixture(harness);
  cleanup.push(made.home, made.root);
  return made;
}

describe("Pi reader", () => {
  it("reads the recorded session: cwd, title, prompts, timestamps", async () => {
    const { home, root } = fixture("pi");
    const reading = await new PiSessionsReader({ home }).read(ALL);
    expect(reading.orchestrations).toEqual([]);
    expect(reading.sessions).toHaveLength(1);
    const [session] = reading.sessions;
    expect(session).toMatchObject({
      harness: "pi",
      cwd: `${root}/wt`,
      title: "Import fixture session",
      userPrompts: 3,
    });
    expect(session?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session?.sessionPath).toMatch(/\.jsonl$/);
    expect(session?.startedAt).toBe("2026-11-24T16:46:55.863Z");
    expect(session?.lastActiveAt).toBe("2026-11-24T16:47:10.164Z");
  });

  it("never reads pi-subagents' nested child sessions (I17)", async () => {
    const { home } = fixture("pi");
    const slug = join(home, ".pi/agent/sessions/--x--");
    const nested = join(slug, "parent-session", "child", "run-0");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-11-24T16:00:00Z", cwd: "/x" })}\n`,
    );
    const reading = await new PiSessionsReader({ home }).read(ALL);
    expect(reading.sessions.map((s) => s.sessionId)).not.toContain("child");
    expect(reading.sessions).toHaveLength(1);
  });

  it("skips files older than `since` and honors PI_CODING_AGENT_DIR", async () => {
    const { home } = fixture("pi");
    const reader = new PiSessionsReader({ home });
    expect(
      (await reader.read({ since: new Date("2030-01-01") })).sessions,
    ).toEqual([]);
    const elsewhere = new PiSessionsReader({
      env: { PI_CODING_AGENT_DIR: join(home, ".pi/agent") },
    });
    expect((await elsewhere.read(ALL)).sessions).toHaveLength(1);
  });

  it("a missing store is an empty reading, never an error", async () => {
    const reading = await new PiSessionsReader({
      home: join(tmpdir(), "hm-no-such-home"),
    }).read(ALL);
    expect(reading).toEqual({ sessions: [], orchestrations: [] });
  });

  it("caches per (path, mtime, size): an unchanged file is not re-parsed", async () => {
    const { home } = fixture("pi");
    const reader = new PiSessionsReader({ home });
    const first = await reader.read(ALL);
    const second = await reader.read(ALL);
    expect(second.sessions[0]).toBe(first.sessions[0]);
    const path = first.sessions[0]?.sessionPath as string;
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    const third = await reader.read(ALL);
    expect(third.sessions[0]).not.toBe(first.sessions[0]);
    expect(third.sessions[0]).toEqual(first.sessions[0]);
  });
});

describe("Claude Code reader", () => {
  it("reads the recorded session: /rename wins over the AI title, typed prompts only", async () => {
    const { home, root } = fixture("claude-code");
    const reading = await new ClaudeSessionsReader({ home }).read(ALL);
    expect(reading.sessions).toHaveLength(1);
    expect(reading.sessions[0]).toMatchObject({
      harness: "claude-code",
      cwd: `${root}/wt`,
      // the fixture holds `ai-title: ONE` and a later `custom-title` from /rename
      title: "reply-with-number-words",
      userPrompts: 3,
      branch: "import-fixture",
    });
    expect(reading.sessions[0]?.startedAt).toMatch(/^2026-11-24T16:4/);
  });

  it("falls back to the AI title without a /rename", async () => {
    const { home } = fixture("claude-code");
    const reader = new ClaudeSessionsReader({ home });
    const [session] = (await reader.read(ALL)).sessions;
    const path = session?.sessionPath as string;
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line && !line.includes('"custom-title"'));
    writeFileSync(path, `${lines.join("\n")}\n`);
    const again = await new ClaudeSessionsReader({ home }).read(ALL);
    expect(again.sessions[0]?.title).toBe("ONE");
  });

  it("skips sidechain-only transcripts (agent-internal, I17) and ignores subagent dirs", async () => {
    const { home, root } = fixture("claude-code");
    const dir = join(home, ".claude/projects/-x");
    mkdirSync(join(dir, "someid", "subagents"), { recursive: true });
    const side = JSON.stringify({
      type: "user",
      isSidechain: true,
      cwd: `${root}/wt`,
      sessionId: "side",
      message: { role: "user", content: "do a thing" },
      timestamp: "2026-11-24T16:00:00Z",
    });
    writeFileSync(join(dir, "side.jsonl"), `${side}\n`);
    writeFileSync(
      join(dir, "someid", "subagents", "agent-1.jsonl"),
      `${side}\n`,
    );
    const reading = await new ClaudeSessionsReader({ home }).read(ALL);
    expect(reading.sessions).toHaveLength(1);
  });

  it("a tool result or meta entry is not a prompt", async () => {
    const { home, root } = fixture("claude-code");
    const dir = join(home, ".claude/projects/-y");
    mkdirSync(dir, { recursive: true });
    const base = {
      cwd: `${root}/wt`,
      sessionId: "s",
      isSidechain: false,
      timestamp: "2026-11-24T16:00:00Z",
      type: "user",
    };
    const lines = [
      { ...base, message: { role: "user", content: "typed" } },
      {
        ...base,
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "x" }],
        },
      },
      { ...base, isMeta: true, message: { role: "user", content: "caveat" } },
      {
        ...base,
        message: {
          role: "user",
          content: "<command-name>/clear</command-name>",
        },
      },
      {
        ...base,
        message: {
          role: "user",
          content: [{ type: "text", text: "typed too" }],
        },
      },
    ];
    writeFileSync(
      join(dir, "s.jsonl"),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    const reading = await new ClaudeSessionsReader({ home }).read(ALL);
    expect(reading.sessions.find((s) => s.sessionId === "s")?.userPrompts).toBe(
      2,
    );
  });
});

describe("Codex reader", () => {
  it("reads the recorded rollout: cwd, the thread name from the index (last wins), typed prompts", async () => {
    const { home, root } = fixture("codex");
    const reading = await new CodexSessionsReader({ home }).read(ALL);
    expect(reading.sessions).toHaveLength(1);
    expect(reading.sessions[0]).toMatchObject({
      harness: "codex",
      cwd: `${root}/wt`,
      // the index holds the auto name "Reply with ONE", then our /rename
      title: "Import fixture thread",
      userPrompts: 3,
      branch: "import-fixture",
    });
    expect(reading.sessions[0]?.sessionPath).toMatch(/rollout-.*\.jsonl$/);
  });

  it("skips non-interactive exec sessions (I17)", async () => {
    const { home } = fixture("codex");
    const [session] = (await new CodexSessionsReader({ home }).read(ALL))
      .sessions;
    const { readFileSync } = await import("node:fs");
    const path = session?.sessionPath as string;
    const text = readFileSync(path, "utf8").replace(
      '"source":"cli"',
      '"source":"exec"',
    );
    expect(text).toContain('"source":"exec"');
    writeFileSync(path, text);
    const again = await new CodexSessionsReader({ home }).read(ALL);
    expect(again.sessions).toEqual([]);
  });

  it("injected context (user-role response items) is not counted as typed prompts", async () => {
    const { home } = fixture("codex");
    const [session] = (await new CodexSessionsReader({ home }).read(ALL))
      .sessions;
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(session?.sessionPath as string, "utf8");
    // the rollout holds 4 user-role response items (1 injected + 3 typed) and 3 UserMessage events
    expect(
      text
        .split("\n")
        .filter(
          (l) => l.includes('"role":"user"') && l.includes('"response_item"'),
        ),
    ).toHaveLength(4);
    expect(session?.userPrompts).toBe(3);
  });
});

describe("Cursor reader", () => {
  it("reads the recorded chat: cwd, title, prompt count, times", async () => {
    const { home, root } = fixture("cursor");
    const reading = await new CursorChatsReader({ home }).read(ALL);
    expect(reading.sessions).toHaveLength(1);
    expect(reading.sessions[0]).toMatchObject({
      harness: "cursor",
      cwd: `${root}/wt`,
      title: "Word One",
      userPrompts: 3,
    });
    expect(reading.sessions[0]?.sessionPath).toContain("/chats/");
    expect(reading.sessions[0]?.lastActiveAt).toBe(
      new Date(1795539024624).toISOString(),
    );
  });

  it("honors CURSOR_CONFIG_DIR and XDG_CONFIG_HOME, skips chats without meta.json", async () => {
    const { home } = fixture("cursor");
    const root = join(home, ".cursor");
    expect(
      (
        await new CursorChatsReader({ env: { CURSOR_CONFIG_DIR: root } }).read(
          ALL,
        )
      ).sessions,
    ).toHaveLength(1);
    expect(
      (
        await new CursorChatsReader({
          env: { XDG_CONFIG_HOME: join(home, "nope") },
        }).read(ALL)
      ).sessions,
    ).toEqual([]);
    mkdirSync(join(root, "chats", "abc", "oldchat"), { recursive: true });
    expect(
      (await new CursorChatsReader({ home }).read(ALL)).sessions,
    ).toHaveLength(1);
  });
});
