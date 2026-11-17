// LocalReviewSupportProbeAccess's filesystem probes against temp dirs: the
// `/plannotator-review` Claude skill is found where Claude Code looks for
// user skills (`$CLAUDE_CONFIG_DIR`, else `~/.claude`, then `skills/`), and
// the Codex one where Codex does (`$CODEX_HOME`/`~/.codex`, `~/.agents`).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalReviewSupportProbeAccess } from "../src/access/local-review-support-probe-access.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harbormaster-review-probe-"));
  roots.push(root);
  return root;
}

async function writeSkill(configDir: string): Promise<void> {
  const dir = join(configDir, "skills", "plannotator-review");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    "---\nname: plannotator-review\n---\n",
  );
}

describe("LocalReviewSupportProbeAccess.claudeReviewSkill", () => {
  it("reads ~/.claude/skills/plannotator-review/SKILL.md, absent when missing", async () => {
    const home = await tempRoot();
    const probes = new LocalReviewSupportProbeAccess({ home, env: {} });
    await expect(probes.claudeReviewSkill()).resolves.toBeUndefined();
    await writeSkill(join(home, ".claude"));
    await expect(probes.claudeReviewSkill()).resolves.toContain(
      "name: plannotator-review",
    );
  });

  it("honours CLAUDE_CONFIG_DIR over ~/.claude", async () => {
    const home = await tempRoot();
    const configDir = join(home, "custom-claude");
    await writeSkill(join(home, ".claude"));
    const probes = new LocalReviewSupportProbeAccess({
      home,
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    await expect(probes.claudeReviewSkill()).resolves.toBeUndefined();
    await writeSkill(configDir);
    await expect(probes.claudeReviewSkill()).resolves.toContain(
      "name: plannotator-review",
    );
  });
});

describe("LocalReviewSupportProbeAccess.codexReviewSkill", () => {
  it("reads $CODEX_HOME/skills, else ~/.codex/skills, then ~/.agents/skills (Plannotator's install script)", async () => {
    const home = await tempRoot();
    const probes = new LocalReviewSupportProbeAccess({ home, env: {} });
    await expect(probes.codexReviewSkill()).resolves.toBeUndefined();
    await writeSkill(join(home, ".agents"));
    await expect(probes.codexReviewSkill()).resolves.toContain(
      "name: plannotator-review",
    );

    const other = await tempRoot();
    const codexHome = join(other, "codex-home");
    await writeSkill(join(other, ".codex"));
    const custom = new LocalReviewSupportProbeAccess({
      home: other,
      env: { CODEX_HOME: codexHome },
    });
    // CODEX_HOME replaces ~/.codex.
    await expect(custom.codexReviewSkill()).resolves.toBeUndefined();
    await writeSkill(codexHome);
    await expect(custom.codexReviewSkill()).resolves.toContain(
      "name: plannotator-review",
    );
  });
});
