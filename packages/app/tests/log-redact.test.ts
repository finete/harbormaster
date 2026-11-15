// Secret redaction at the main.log write boundary (log-redact.ts, applied
// in app-log.ts): each pattern, no false positives on what the log is full
// of (task ids, paths, branch names, JSON lines), idempotence, the write
// path itself, and speed (a 2 KB line well under 1 ms).

import { describe, expect, it } from "vitest";
import { type AppLogFs, createAppLog } from "../src/main/app-log";
import { REDACTED, redactString } from "../src/main/diagnostics";
import { redactLogLine } from "../src/main/log-redact";

const cases: Array<[string, string, string]> = [
  [
    "anthropic key",
    "key sk-ant-api03-AbCdEf1234567890_xyzXYZ-0987654321abc done",
    "key [redacted:anthropic-key] done",
  ],
  [
    "openai key",
    "OPENAI sk-Ab12Cd34Ef56Gh78Ij90KlMnOp end",
    "OPENAI [redacted:openai-key] end",
  ],
  [
    "openai project key",
    "using sk-proj-Ab12Cd34Ef56Gh78Ij90KlMnOpQr",
    "using [redacted:openai-key]",
  ],
  [
    "github classic token",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok",
    "token [redacted:github-token] ok",
  ],
  [
    "github oauth/server tokens",
    "gho_abcdefghijklmnopqrstuv12 ghs_abcdefghijklmnopqrstuv12",
    "[redacted:github-token] [redacted:github-token]",
  ],
  [
    "github fine-grained PAT",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "[redacted:github-token]",
  ],
  ["aws access key id", "AKIAIOSFODNN7EXAMPLE used", "[redacted:aws-key] used"],
  [
    "aws secret",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "aws_secret_access_key = [redacted:aws-secret]",
  ],
  [
    "jwt",
    "cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U!",
    "cookie [redacted:jwt]!",
  ],
  [
    "slack token",
    "xoxb-1234567890-abcdefghij here",
    "[redacted:slack-token] here",
  ],
  [
    "private key block",
    'key: "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXk\\n-----END OPENSSH PRIVATE KEY-----" after',
    'key: "[redacted:private-key]" after',
  ],
  [
    "unterminated private key",
    "-----BEGIN RSA PRIVATE KEY----- MIIEow",
    "[redacted:private-key]",
  ],
  [
    "bearer",
    "Authorization: Bearer abc.DEF-123_456~xyz/789=",
    "Authorization: Bearer [redacted:bearer]",
  ],
  [
    "url credentials",
    "fetch https://bob:s3cret@example.com/repo.git failed",
    "fetch https://[redacted:url-credentials]@example.com/repo.git failed",
  ],
  [
    "token query params",
    "GET https://x.test/cb?code=1&access_token=abc123&token=zzz#frag",
    "GET https://x.test/cb?code=1&access_token=[redacted:token]&token=[redacted:token]#frag",
  ],
  [
    "KEY=value secrets",
    "env GH_TOKEN=abc123 DB_PASSWORD=hunter2 STRIPE_API_KEY=sk_live_1 SESSION_COOKIE=c1 MY_CREDENTIALS=x PRIVATE_KEY=y CLIENT_SECRET=z",
    "env GH_TOKEN=[redacted:secret] DB_PASSWORD=[redacted:secret] STRIPE_API_KEY=[redacted:secret] SESSION_COOKIE=[redacted:secret] MY_CREDENTIALS=[redacted:secret] PRIVATE_KEY=[redacted:secret] CLIENT_SECRET=[redacted:secret]",
  ],
];

describe("redactLogLine", () => {
  for (const [name, input, expected] of cases) {
    it(`redacts: ${name}`, () => {
      expect(redactLogLine(input)).toBe(expected);
    });
  }

  it("leaves ordinary log lines alone", () => {
    const lines = [
      '2026-01-01T00:00:00.000Z [LOG] [pty] spawn {"task":"3f2a9c1e-7b4d-4e2a-9f1c-0a1b2c3d4e5f","kind":"background","cwd":"/Users/alice/Code/fixture-repo","argv":["pi","<prompt 42 chars>"]}',
      "[main] PATH: /Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      "[main] pi resolved to: /Users/alice/.pi/bin/pi",
      "git checkout -b fix/token-refresh-on-sk-expiry origin/main",
      "branch alice/task-sk-assessment-for-risk-model-v2 pushed",
      "https://finete@github.com/finete/harbormaster.git",
      '{"tokenCount":4096,"maxTokens":8192,"secretsScanned":true}',
      "[tool-socket] inbox_claim failed: task 9b1d not found",
      "Bearer authentication is not configured",
      "/Users/alice/.harbormaster/worktrees/harbormaster/feat-api-key-rotation",
    ];
    for (const line of lines) expect(redactLogLine(line)).toBe(line);
  });

  it("is idempotent and leaves the export redaction working on top", () => {
    for (const [, input] of cases) {
      const once = redactLogLine(input);
      expect(redactLogLine(once)).toBe(once);
      expect(redactString(once)).not.toContain(REDACTED.repeat(2));
    }
  });

  it("redacts a 2 KB line well under 1 ms", () => {
    const filler =
      '[pty] data {"task":"3f2a9c1e-7b4d-4e2a-9f1c-0a1b2c3d4e5f","cwd":"/Users/alice/Code/repo"} ';
    let line = "";
    while (line.length < 2048) line += filler;
    line += " GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 50; i++) redactLogLine(line); // warm up
    const runs = 500;
    const start = performance.now();
    for (let i = 0; i < runs; i++) redactLogLine(line);
    const perLine = (performance.now() - start) / runs;
    expect(perLine).toBeLessThan(0.5);
    expect(redactLogLine(line)).not.toContain("ghp_");
  });
});

describe("app-log write path", () => {
  it("never writes a secret to the file", async () => {
    let written = "";
    const fs: AppLogFs = {
      appendFile: async (_path, data) => {
        written += data;
      },
      mkdir: async () => {},
      stat: async () => ({ size: 0 }),
      rename: async () => {},
    };
    const log = createAppLog("/logs/main.log", fs);
    log.write("error", [
      "push failed:",
      new Error("https://bob:pw123@github.com/x.git denied"),
      { env: { GH_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
    ]);
    await log.flush();
    expect(written).toContain("[redacted:url-credentials]");
    expect(written).toContain("[redacted:github-token]");
    expect(written).not.toContain("pw123");
    expect(written).not.toContain("ghp_abc");
  });
});
