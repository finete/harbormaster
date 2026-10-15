#!/usr/bin/env node
// `npm run migrate-from-pihome` entry point. Dry-run by default; `--apply`
// writes. See `manager/migration-manager.ts` for what actually happens and
// README.md ("Migrating from pi-home") for usage.

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STATE_DIR } from "../utilities/state-paths.js";
import type { MigrationOptions } from "./contracts.js";
import { runMigration } from "./manager/migration-manager.js";

const DEFAULT_PIHOME_DIR = join(homedir(), ".pi", "agent", "pi-home");

function parseArgs(argv: string[]): MigrationOptions {
  let piHomeDir = DEFAULT_PIHOME_DIR;
  let stateDir = DEFAULT_STATE_DIR;
  let apply = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--force") force = true;
    else if (arg === "--pihome-dir") piHomeDir = requireValue(argv, ++i, arg);
    else if (arg === "--state-dir") stateDir = requireValue(argv, ++i, arg);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { piHomeDir, stateDir, apply, force };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: npm run migrate-from-pihome -- [options]

Migrates pi-home tasks (permanent and temporary, including done/archived)
into Harbormaster's task store. Read-only toward pi-home except for one
write on a successful --apply (pi-home's automation flag is set to false).

Options:
  --dry-run          Report what would happen without writing anything (default).
  --apply            Actually write the migrated tasks.
  --force            Proceed with --apply even if pi-home shows live sessions.
  --pihome-dir <dir> Override pi-home's state directory (default: ~/.pi/agent/pi-home).
  --state-dir <dir>  Override Harbormaster's state directory (default: ~/.harbormaster).
  --help             Show this help.
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `Migrating from pi-home (${options.piHomeDir}) into Harbormaster (${options.stateDir})` +
      (options.apply ? " — APPLYING" : " — dry run, pass --apply to write") +
      (options.force ? " [--force]" : ""),
  );

  const report = await runMigration(options);

  console.log("");
  console.log(`Imported: ${report.imported.length}`);
  for (const item of report.imported) {
    console.log(`  + ${item.title} (pihome: ${item.pihomeIssueId})`);
  }

  console.log(`Skipped: ${report.skipped.length}`);
  for (const item of report.skipped) {
    console.log(
      `  - ${item.title} (pihome: ${item.pihomeIssueId}): ${item.reason ?? ""}`,
    );
  }

  if (report.warnings.length > 0) {
    console.log(`Warnings: ${report.warnings.length}`);
    for (const warning of report.warnings) console.log(`  ! ${warning}`);
  }

  if (report.livePresenceBlocking.length > 0) {
    console.log("");
    console.log("Live pi-home sessions blocking --apply:");
    for (const record of report.livePresenceBlocking) {
      console.log(
        `  task ${record.taskId}: pid ${record.pid}, session ${record.sessionPath}`,
      );
    }
    console.log(
      "Close those panes, or re-run with --force once you've confirmed it's safe.",
    );
  }

  if (report.automationDisabledInPiHome) {
    console.log("");
    console.log(
      "*** pi-home's automation was set to false in its config.json. " +
        'This is reversible: set "automation": true back in that file if you need it again. ***',
    );
  }

  if (report.dryRun && options.apply) {
    console.log("");
    console.log(
      "Nothing was written (see warnings above for why --apply was refused).",
    );
    process.exitCode = 1;
  } else if (report.dryRun) {
    console.log("");
    console.log(
      "Dry run only — nothing was written. Re-run with --apply to write.",
    );
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
