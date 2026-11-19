// The Settings page (docs/settings.md): a page like Inbox / Rules / Costs
// (S2: Cmd/Ctrl+, or the app menu's "Settings…"; Esc goes back), sections
// on the left and the selected one on the right (S7), each section its own
// component. Changes apply immediately (S5); the page follows config.json
// live (S4) and says so plainly when the file has a problem. Footer:
// "Edit in config.json" (main opens the file; the renderer never touches
// it) and "Run setup again" (the first-run wizard over the app, S3).

import {
  AlertTriangle,
  Bot,
  FileDiff,
  FileJson,
  Github,
  Inbox,
  RotateCw,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect } from "react";
import type { SettingSectionId } from "../../../../preload/api";
import { isTypingTarget } from "../../lib/keyboard-guard";
import { configErrorText, SETTINGS_SECTIONS } from "../../lib/settings-form";
import { useLastOpenInAppId, useOpenInApps } from "../../lib/use-open-in";
import { useSettings } from "../../lib/use-settings";
import { describeThrown, pushToast } from "../../toast";
import { SidebarRevealButton } from "../SidebarReveal";
import { Button } from "../ui/button";
import { SidebarNavItem } from "../ui/sidebar-nav";
import { AgentsSection } from "./AgentsSection";
import { CodeReviewSection } from "./CodeReviewSection";
import { GeneralSection } from "./GeneralSection";
import { GithubSection } from "./GithubSection";
import { InboxSection } from "./InboxSection";

const SECTION_ICONS: Partial<Record<SettingSectionId, ReactNode>> = {
  general: <SlidersHorizontal />,
  agents: <Bot />,
  "code-review": <FileDiff />,
  github: <Github />,
  inbox: <Inbox />,
};

/** "Edit in config.json": in the last used editor, else the first installed one, else the OS default. */
function useEditConfig(): () => void {
  const apps = useOpenInApps();
  const lastId = useLastOpenInAppId();
  return useCallback(() => {
    const editor =
      apps.find((app) => app.id === lastId && app.kind === "editor") ??
      apps.find((app) => app.kind === "editor");
    window.harbormaster.app
      .openConfigFile(editor?.id)
      .then((result) => {
        if (!result.ok) pushToast(`Open config.json: ${result.error}`);
      })
      .catch((error: unknown) =>
        pushToast(`Open config.json: ${describeThrown(error)}`),
      );
  }, [apps, lastId]);
}

export function SettingsView({
  section,
  onSectionChange,
  active,
  onBack,
  onOpenRules,
  onRunSetup,
}: {
  section: SettingSectionId;
  onSectionChange(section: SettingSectionId): void;
  /** The page is showing and no dialog is up: Esc is live. */
  active: boolean;
  /** Esc: back to the previous view. */
  onBack(): void;
  /** General → "Manage rules →" (the automation switch lives there, S13). */
  onOpenRules(): void;
  /** Footer → "Run setup again". */
  onRunSetup(): void;
}): JSX.Element {
  const model = useSettings();
  const { snapshot, loadError } = model;
  const editConfig = useEditConfig();

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented) return;
      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }
      // Esc in a field leaves the field (which reverts its draft) first.
      if (isTypingTarget(event.target)) {
        (event.target as HTMLElement).blur();
        return;
      }
      event.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onBack]);

  const label =
    SETTINGS_SECTIONS.find((entry) => entry.id === section)?.label ?? "";

  return (
    <div
      data-testid="settings-view"
      data-section={section}
      className="flex h-full min-w-0 flex-1 flex-col"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <SidebarRevealButton />
        <Settings2 className="h-4 w-4 text-foreground" aria-hidden />
        <span className="text-sm font-medium" data-testid="settings-title">
          Settings
        </span>
        <span className="text-xs text-muted-foreground">
          changes apply immediately
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="settings-back"
            title="Back (Esc)"
            onClick={onBack}
          >
            Done
          </Button>
        </div>
      </header>
      {snapshot?.error && (
        <div
          role="alert"
          data-testid="settings-config-error"
          className="flex shrink-0 items-center gap-3 border-b border-status-needsYou/40 bg-status-needsYou/10 px-4 py-2 text-sm"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-status-needsYou" />
          <p className="min-w-0 flex-1">
            {configErrorText(snapshot.error)}
            <span className="text-muted-foreground">
              {" "}
              · Showing the last good settings until it is fixed.
            </span>
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="settings-config-error-edit"
            onClick={editConfig}
          >
            Edit in config.json
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-chrome p-2"
        >
          {SETTINGS_SECTIONS.map((entry) => (
            <SidebarNavItem
              key={entry.id}
              icon={SECTION_ICONS[entry.id] ?? null}
              label={entry.label}
              active={entry.id === section}
              testId={`settings-nav-${entry.id}`}
              onClick={() => onSectionChange(entry.id)}
            />
          ))}
          <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              data-testid="settings-edit-config"
              title="Every setting, plus the rare ones not shown here"
              onClick={editConfig}
            >
              <FileJson />
              Edit in config.json
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              data-testid="settings-run-setup"
              onClick={onRunSetup}
            >
              <RotateCw />
              Run setup again
            </Button>
          </div>
        </nav>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-8 py-6">
            <h2
              className="text-lg font-semibold"
              data-testid="settings-section-title"
            >
              {label}
            </h2>
            {!snapshot ? (
              <p className="text-sm text-muted-foreground">
                {loadError
                  ? `Could not read settings: ${loadError}`
                  : "Loading…"}
              </p>
            ) : section === "general" ? (
              <GeneralSection
                model={model}
                snapshot={snapshot}
                onOpenRules={onOpenRules}
              />
            ) : section === "agents" ? (
              <AgentsSection
                model={model}
                snapshot={snapshot}
                onEditConfig={editConfig}
              />
            ) : section === "github" ? (
              <GithubSection
                model={model}
                snapshot={snapshot}
                onEditConfig={editConfig}
              />
            ) : section === "inbox" ? (
              <InboxSection
                model={model}
                snapshot={snapshot}
                onEditConfig={editConfig}
              />
            ) : (
              <CodeReviewSection snapshot={snapshot} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
