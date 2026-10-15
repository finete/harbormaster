// Resource Access: the ONE write this module ever makes into pi-home's home
// directory — flipping `automation: false` in `<piHomeDir>/config.json`
// after a successful `--apply`, so pi-home's own movers stop touching tasks
// that now live in Harbormaster. Every other field in the file round-trips
// untouched. Reversible: setting `automation: true` back (by hand, or
// pi-home's own settings) restores pi-home's prior behavior.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../../utilities/atomic-json.js";

export class PiHomeConfigAccess {
  readonly configPath: string;

  constructor(piHomeDir: string) {
    this.configPath = join(piHomeDir, "config.json");
  }

  async readAutomation(): Promise<boolean> {
    const raw = await this.readRaw();
    return raw.automation !== false;
  }

  /** The one write: flips `automation` to `false`, preserving every other field verbatim. */
  async disableAutomation(): Promise<void> {
    const raw = await this.readRaw();
    await writeJsonAtomic(this.configPath, { ...raw, automation: false });
  }

  private async readRaw(): Promise<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.configPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Cannot read pi-home config at ${this.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Unexpected pi-home config shape at ${this.configPath}`);
    }
    return parsed as Record<string, unknown>;
  }
}
