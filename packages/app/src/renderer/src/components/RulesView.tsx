// The Rules page (docs/rules-page.md): a read-only view of the rules
// engine, a top-level view like the inbox (sidebar Rules row or Cmd/Ctrl+
// Shift+R; the sidebar stays). Top bar: Rules | Activity tabs, the Rules
// on/off switch (`setRulesEnabled`) and "Open rules folder". The Rules tab
// lists every loaded rule grouped by file (components/RulesList.tsx) with
// the selected rule in a non-modal sheet (RuleSheet.tsx); the Activity tab
// is the audit log (RulesActivity.tsx). Data: `listRules()` on open and on
// every refresh tick (main's `core:refreshed` push); nothing else. The
// page's selection, tab and filters live in App (`RulesPageMemory`) so
// they survive leaving and reopening the page within the session.
import { FolderOpen, ListChecks } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AuditEntry,
  RepositoryInfo,
  RulesListing,
} from "../../../preload/api";
import { flattenBoard, useBoard } from "../core-client";
import { isTypingTarget } from "../lib/keyboard-guard";
import { defaultOpenInApp } from "../lib/open-in";
import { repositoryLabel } from "../lib/repository-label";
import {
  type ActivityFilter,
  moveRuleSelection,
  type RuleKey,
  ruleKeyString,
  rulesFolder,
  sinceDaysAgo,
} from "../lib/rules-format";
import { useNow } from "../lib/use-now";
import {
  openPathIn,
  useLastOpenInAppId,
  useOpenInApps,
} from "../lib/use-open-in";
import { cn } from "../lib/utils";
import { describeThrown, pushToast } from "../toast";
import { RuleSheet } from "./RuleSheet";
import { RulesActivity } from "./RulesActivity";
import { NO_RULES_FOLDER_TITLE, RulesList } from "./RulesList";
import { Kbd } from "./ui/kbd";
import { Segmented } from "./ui/segmented";

export type RulesTab = "rules" | "activity";

/** What the page remembers across leaving and reopening it (App owns it). */
export interface RulesPageMemory {
  tab: RulesTab;
  selected: RuleKey | null;
  filter: ActivityFilter;
  showEvents: boolean;
}

export const INITIAL_RULES_PAGE: RulesPageMemory = {
  tab: "rules",
  selected: null,
  filter: {},
  showEvents: false,
};

const ACTIVITY_LIMIT = 5000;

export function RulesView({
  active,
  memory,
  onMemoryChange,
  onOpenTask,
  onBack,
}: {
  /** The page is showing and no dialog is up: keys are live. */
  active: boolean;
  memory: RulesPageMemory;
  onMemoryChange: (
    update: (memory: RulesPageMemory) => RulesPageMemory,
  ) => void;
  onOpenTask: (taskId: string) => void;
  /** Esc with no sheet open: back to the previous view. */
  onBack: () => void;
}): JSX.Element {
  const now = useNow();
  const [listing, setListing] = useState<RulesListing | null>(null);
  const [revision, setRevision] = useState(0);
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const apps = useOpenInApps();
  const lastAppId = useLastOpenInAppId();
  const columns = useBoard();

  const load = useCallback(() => {
    void window.harbormaster.core
      .listRules()
      .then((next) => {
        setListing(next);
        setRevision((count) => count + 1);
      })
      .catch((error: unknown) =>
        pushToast(`Could not read the rules: ${describeThrown(error)}`),
      );
  }, []);

  // On open, and on every refresh tick.
  useEffect(() => {
    load();
    void window.harbormaster.core
      .listRepositories()
      .then(setRepositories)
      .catch(() => {});
    return window.harbormaster.core.onRefreshed(load);
  }, [load]);

  // The Activity tab's window, re-read with the listing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is a re-read trigger.
  useEffect(() => {
    if (memory.tab !== "activity") return;
    let cancelled = false;
    const days = listing?.activityWindowDays ?? 30;
    void window.harbormaster.core
      .listEvents({
        since: sinceDaysAgo(Date.now(), days),
        limit: ACTIVITY_LIMIT,
      })
      .then((entries) => {
        if (!cancelled) setActivity(entries);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [memory.tab, revision]);

  const tasks = useMemo(() => {
    const titles = new Map<string, string>();
    for (const { task } of flattenBoard(columns))
      titles.set(task.id, task.title);
    return titles;
  }, [columns]);
  const taskTitle = useCallback((taskId: string) => tasks.get(taskId), [tasks]);
  const repoLabel = useCallback(
    (repositoryId: string) => {
      const repo = repositories.find((entry) => entry.id === repositoryId);
      return repo ? repositoryLabel(repo) : repositoryId;
    },
    [repositories],
  );

  const files = listing?.files ?? [];
  const order = useMemo(
    () =>
      files.flatMap((file) =>
        file.rules.map((rule) =>
          ruleKeyString({ file: rule.file, ruleId: rule.id }),
        ),
      ),
    [files],
  );
  const selectedKey = memory.selected ? ruleKeyString(memory.selected) : null;
  const selectedFile = memory.selected
    ? files.find((file) => file.file === memory.selected?.file)
    : undefined;
  const selectedRule = selectedFile?.rules.find(
    (rule) => rule.id === memory.selected?.ruleId,
  );
  const folder = rulesFolder(files);

  const openWithDefault = useCallback(
    (path: string) => {
      const app = defaultOpenInApp(apps, lastAppId);
      if (!app) {
        pushToast("No app to open it in");
        return;
      }
      void openPathIn(path, app);
    },
    [apps, lastAppId],
  );

  const select = useCallback(
    (key: RuleKey | null) =>
      onMemoryChange((current) => ({ ...current, selected: key })),
    [onMemoryChange],
  );
  const setTab = useCallback(
    (tab: RulesTab) => onMemoryChange((current) => ({ ...current, tab })),
    [onMemoryChange],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setListing((current) => (current ? { ...current, enabled } : current));
      void window.harbormaster.core
        .setRulesEnabled(enabled)
        .catch((error: unknown) =>
          pushToast(
            `Could not turn rules ${enabled ? "on" : "off"}: ${describeThrown(error)}`,
          ),
        )
        .finally(load);
    },
    [load],
  );

  const restoreDefaults = useCallback(() => {
    void window.harbormaster.onboarding
      .ensureDefaultRules()
      .catch((error: unknown) =>
        pushToast(
          `Could not restore the default rules: ${describeThrown(error)}`,
        ),
      )
      .finally(load);
  }, [load]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented) return;
      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }
      if (event.key === "Escape") {
        if (isTypingTarget(event.target)) {
          (event.target as HTMLElement).blur();
          return;
        }
        event.preventDefault();
        if (memory.tab === "rules" && memory.selected) select(null);
        else onBack();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (memory.tab !== "rules") return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const next = moveRuleSelection(
        order,
        selectedKey,
        event.key === "ArrowDown" ? 1 : -1,
      );
      if (!next) return;
      const hash = next.lastIndexOf("#");
      select({ file: next.slice(0, hash), ruleId: next.slice(hash + 1) });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, memory.tab, memory.selected, order, selectedKey, select, onBack]);

  // Keep the selected row in view as ↑/↓ move it.
  useEffect(() => {
    if (!selectedKey) return;
    document
      .querySelector(`[data-rule-key="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const enabled = listing?.enabled ?? true;
  return (
    <div
      data-testid="rules-view"
      data-tab={memory.tab}
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <ListChecks className="h-4 w-4 text-foreground" aria-hidden />
        <span className="text-sm font-medium">Rules</span>
        <Segmented
          ariaLabel="Rules tabs"
          size="sm"
          className="ml-2"
          value={memory.tab}
          onValueChange={setTab}
          options={[
            { value: "rules", label: "Rules", testId: "rules-tab-rules" },
            {
              value: "activity",
              label: "Activity",
              testId: "rules-tab-activity",
            },
          ]}
        />
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[11px] text-muted-foreground lg:inline">
            <Kbd>↑</Kbd>/<Kbd>↓</Kbd> move · <Kbd>Esc</Kbd> close
          </span>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Rules {enabled ? "on" : "off"}
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Rules on/off"
              data-testid="rules-enabled-switch"
              disabled={!listing}
              title={
                enabled
                  ? "Rules are on: turn them off"
                  : "Rules are off: turn them on"
              }
              onClick={() => setEnabled(!enabled)}
              className={cn(
                "relative h-4 w-7 shrink-0 rounded-full border transition-colors duration-[120ms] ease-out disabled:opacity-50",
                enabled
                  ? "border-primary bg-primary"
                  : "border-border bg-muted",
              )}
            >
              <span
                className={cn(
                  "absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-[left] duration-[120ms] ease-out",
                  enabled
                    ? "left-[calc(100%-0.8125rem)] bg-primary-foreground"
                    : "left-px bg-muted-foreground",
                )}
              />
            </button>
          </label>
          <button
            type="button"
            data-testid="rules-open-folder"
            disabled={!folder}
            title={folder ?? NO_RULES_FOLDER_TITLE}
            onClick={() => folder && openWithDefault(folder)}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            Open rules folder
          </button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {memory.tab === "rules" ? (
          listing ? (
            <>
              <RulesList
                listing={listing}
                repoLabel={repoLabel}
                selected={selectedKey}
                now={now}
                onSelect={select}
                onOpenFile={openWithDefault}
                onOpenFolder={
                  folder ? () => openWithDefault(folder) : undefined
                }
                onRestoreDefaults={restoreDefaults}
                onTurnOn={() => setEnabled(true)}
              />
              {selectedRule && selectedFile && (
                <RuleSheet
                  key={selectedKey}
                  rule={selectedRule}
                  path={selectedFile.path}
                  now={now}
                  revision={revision}
                  taskTitle={taskTitle}
                  onOpenTask={onOpenTask}
                  onClose={() => select(null)}
                  onViewAllActivity={(rule) =>
                    onMemoryChange((current) => ({
                      ...current,
                      tab: "activity",
                      filter: { rule },
                    }))
                  }
                />
              )}
            </>
          ) : null
        ) : (
          <RulesActivity
            entries={activity}
            listing={listing}
            filter={memory.filter}
            onFilterChange={(filter) =>
              onMemoryChange((current) => ({ ...current, filter }))
            }
            showEvents={memory.showEvents}
            onShowEventsChange={(showEvents) =>
              onMemoryChange((current) => ({ ...current, showEvents }))
            }
            now={now}
            taskTitle={taskTitle}
            onOpenTask={onOpenTask}
            onOpenRule={(rule) =>
              onMemoryChange((current) => ({
                ...current,
                tab: "rules",
                selected: rule,
              }))
            }
          />
        )}
      </div>
    </div>
  );
}
