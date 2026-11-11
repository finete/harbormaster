// The first-run wizard's IPC (docs/release-plan.md "Onboarding (four
// screens)"). Every read and write is a core command: main only forwards,
// so the renderer never touches the filesystem, the config file, or a CLI.
// The probes (`--version`, `gh auth status`, the repository scan) run in
// core's process runner with short timeouts and resolve asynchronously, so
// the wizard never blocks on them.

import type { CoreCommands, SetDefaultAgentInput } from "@harbormaster/core";
import { BrowserWindow, type IpcMain } from "electron";

/**
 * Whether the wizard shows at startup: never finished (no
 * `config.onboardingCompletedAt`) and not skipped. `HARBORMASTER_SKIP_ONBOARDING=1`
 * is for the e2e suite only (playwright.config.ts sets it for every spec
 * but the onboarding one); the packaged app never sets it.
 */
export function shouldShowOnboarding(
  completedAt: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return !completedAt && env.HARBORMASTER_SKIP_ONBOARDING !== "1";
}

export function registerOnboardingIpc(
  ipcMain: IpcMain,
  commands: CoreCommands,
  env: NodeJS.ProcessEnv = process.env,
): void {
  ipcMain.handle("onboarding:shouldShow", async () => {
    const state = await commands.getOnboardingState();
    return shouldShowOnboarding(state.completedAt, env);
  });
  ipcMain.handle("onboarding:getState", () => commands.getOnboardingState());
  ipcMain.handle("onboarding:scanCodeRoot", (_event, path: string) =>
    commands.scanCodeRoot(String(path ?? "")),
  );
  ipcMain.handle(
    "onboarding:setCodeRoot",
    (_event, path: string, options?: { create?: boolean }) =>
      commands.setCodeRoot(String(path ?? ""), {
        create: options?.create === true,
      }),
  );
  ipcMain.handle("onboarding:detectAgents", () => commands.detectAgents());
  ipcMain.handle(
    "onboarding:setDefaultAgent",
    (_event, input: SetDefaultAgentInput) => commands.setDefaultAgent(input),
  );
  ipcMain.handle("onboarding:githubAuthStatus", () =>
    commands.githubAuthStatus(),
  );
  ipcMain.handle(
    "onboarding:setSourceEnabled",
    (_event, sourceId: string, enabled: boolean) =>
      commands.setSourceEnabled(String(sourceId ?? ""), enabled === true),
  );
  ipcMain.handle("onboarding:ensureDefaultRules", () =>
    commands.ensureDefaultRules(),
  );
  ipcMain.handle("onboarding:complete", () => commands.completeOnboarding());
}

/** The "Welcome / Setup…" menu item: every window reopens the wizard. */
export function showOnboardingInWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send("onboarding:show");
  }
}
