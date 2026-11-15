// `core:doctor` (the Setup screen's "Check setup") and the doctor half of
// Export Diagnostics. Main only forwards to the core `doctor` command, adding
// the facts only the app knows: the login-shell PATH it read at start (see
// login-shell-path.ts), its bundle path and version. The renderer never
// probes anything itself.

import {
  type CoreCommands,
  type DoctorInput,
  type DoctorReport,
  doctorPlainSummary,
} from "@harbormaster/core";
import type { IpcMain } from "electron";

export interface DoctorHostFacts {
  /** The login shell's PATH as read at start (undefined when not read, e.g. e2e). */
  loginShellPath(): string | undefined;
  appPath: string;
  appVersion: string;
}

/** The `doctor` input for this app instance. */
export function appDoctorInput(facts: DoctorHostFacts): DoctorInput {
  const loginShellPath = facts.loginShellPath();
  return {
    ...(loginShellPath ? { loginShellPath } : {}),
    appPath: facts.appPath,
    appVersion: facts.appVersion,
  };
}

/**
 * How long Export Diagnostics waits for the doctor before zipping without
 * it: `gh auth status` and then one round of `ls-remote`s, each up to core's
 * 20 s network probe limit, plus slack.
 */
export const DIAGNOSTICS_DOCTOR_TIMEOUT_MS = 45_000;

/** The doctor report for a diagnostics bundle, or why it is missing (never throws). */
export async function doctorForDiagnostics(
  commands: Pick<CoreCommands, "doctor">,
  facts: DoctorHostFacts,
  timeoutMs = DIAGNOSTICS_DOCTOR_TIMEOUT_MS,
): Promise<DoctorReport | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      commands.doctor(appDoctorInput(facts)),
      new Promise<{ error: string }>((resolve) => {
        timer = setTimeout(
          () => resolve({ error: `doctor timed out after ${timeoutMs} ms` }),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The "Copy summary" text for the export toast: app and OS versions, the
 * agent versions, and every failing / warning check (or why the doctor
 * could not run).
 */
export function diagnosticsSummary(
  doctor: DoctorReport | { error: string },
  facts: { appVersion: string; os: string },
): string {
  if ("error" in doctor) {
    return [
      `Harbormaster ${facts.appVersion} on ${facts.os}`,
      `doctor: could not run (${doctor.error})`,
    ].join("\n");
  }
  return doctorPlainSummary(doctor, facts);
}

export function registerDoctorIpc(
  ipcMain: IpcMain,
  commands: Pick<CoreCommands, "doctor">,
  facts: DoctorHostFacts,
): void {
  ipcMain.handle("core:doctor", () => commands.doctor(appDoctorInput(facts)));
}
