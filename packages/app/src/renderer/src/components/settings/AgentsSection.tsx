// Settings → Agents (docs/settings.md "Settings in v1"): default agent
// (built-ins + custom agents), default model (from the `listModels`
// catalog of the default agent; free text when it lists none), skipping
// permission prompts for launched tasks, the concurrency cap, the max
// nesting depth (with a note when deeper trees exist), and the
// custom agents as a read-only list (S9) with found / not found from the
// same detection the wizard uses. "Overridden in N repositories" under the
// default agent and the bypass switch (S8).

import { treesDeeperThan } from "@harbormaster/core/dist/engines/task-nesting.js";
import { Check, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  DetectedAgent,
  HarnessModelCatalog,
  SettingsSnapshot,
} from "../../../../preload/api";
import { flattenBoard, useBoard } from "../../core-client";
import {
  findSetting,
  modelChoices,
  overriddenHint,
  parseStringDraft,
  valueText,
} from "../../lib/settings-form";
import { deeperTreesNote } from "../../lib/task-lineage";
import type { SettingsModel } from "../../lib/use-settings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  CommitField,
  DescribedSetting,
  SelectField,
  SettingRow,
  SettingsCard,
} from "./SettingRow";

/** The `listModels` catalogs (`null` while loading; empty on failure). */
function useModelCatalogs(): HarnessModelCatalog[] | null {
  const [catalogs, setCatalogs] = useState<HarnessModelCatalog[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.harbormaster.core
      .listModels()
      .then((next) => {
        if (!cancelled) setCatalogs(next);
      })
      .catch(() => {
        if (!cancelled) setCatalogs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return catalogs;
}

/** Custom agents as detected (re-detected when the configured list changes). */
function useCustomAgents(customIds: string): DetectedAgent[] | null {
  const [agents, setAgents] = useState<DetectedAgent[] | null>(null);
  useEffect(() => {
    if (!customIds) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    window.harbormaster.onboarding
      .detectAgents()
      .then((detected) => {
        if (!cancelled) setAgents(detected.filter((agent) => agent.custom));
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customIds]);
  return agents;
}

export function AgentsSection({
  model,
  snapshot,
  onEditConfig,
}: {
  model: Pick<SettingsModel, "update">;
  snapshot: SettingsSnapshot;
  onEditConfig(): void;
}): JSX.Element {
  const catalogs = useModelCatalogs();
  const customIds = snapshot.harnesses
    .filter((option) => option.custom)
    .map((option) => option.id)
    .join("\n");
  const customAgents = useCustomAgents(customIds);
  const defaultHarness = valueText(snapshot.values["launch.defaultHarness"]);
  const harnessLabel =
    snapshot.harnesses.find((option) => option.id === defaultHarness)?.label ??
    defaultHarness;
  const modelSetting = findSetting(snapshot, "launch.defaultModel");
  // Trees already deeper than the max stay as they are (decision 9): say so.
  const maxNestingDepth = snapshot.values["launch.maxNestingDepth"];
  const board = useBoard();
  const deeperTrees =
    typeof maxNestingDepth === "number"
      ? treesDeeperThan(
          flattenBoard(board).map((row) => row.task),
          maxNestingDepth,
        )
      : 0;
  return (
    <div className="flex flex-col gap-6">
      <SettingsCard>
        <DescribedSetting
          model={model}
          snapshot={snapshot}
          settingKey="launch.defaultHarness"
          note={overriddenHint(snapshot.overriddenIn["launch.defaultHarness"])}
        />
        <DescribedSetting
          model={model}
          snapshot={snapshot}
          settingKey="launch.defaultModel"
          control={({ value, write, onProblem }) => {
            const current = typeof value === "string" ? value : null;
            const choices = catalogs
              ? modelChoices(catalogs, defaultHarness, current)
              : undefined;
            if (catalogs === null) {
              return (
                <Button variant="secondary" size="sm" disabled>
                  Loading models…
                </Button>
              );
            }
            if (!choices || !modelSetting) {
              return (
                <CommitField
                  value={value}
                  parse={(text) =>
                    modelSetting
                      ? parseStringDraft(text, modelSetting)
                      : { ok: true, value: text.trim() || null }
                  }
                  onCommit={write}
                  onProblem={onProblem}
                  testId="setting-input-launch.defaultModel"
                  label="Default model"
                  placeholder={`${harnessLabel} default`}
                />
              );
            }
            return (
              <SelectField
                value={current ?? ""}
                options={choices}
                onChange={(next) => {
                  void write(next === "" ? null : next).then(onProblem);
                }}
                testId="setting-input-launch.defaultModel"
                label="Default model"
              />
            );
          }}
        />
        <DescribedSetting
          model={model}
          snapshot={snapshot}
          settingKey="launch.bypassPermissions"
          note={overriddenHint(
            snapshot.overriddenIn["launch.bypassPermissions"],
          )}
        />
        <DescribedSetting
          model={model}
          snapshot={snapshot}
          settingKey="launch.maxConcurrent"
        />
        <DescribedSetting
          model={model}
          snapshot={snapshot}
          settingKey="launch.maxNestingDepth"
          note={deeperTreesNote(deeperTrees)}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingRow
          testId="settings-custom-agents"
          title="Custom agents"
          help="Other agent CLIs, pickable as the default agent."
          below={
            <div className="flex flex-col gap-2">
              {customIds === "" ? (
                <p className="text-xs text-muted-foreground">
                  No custom agents.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {snapshot.harnesses
                    .filter((option) => option.custom)
                    .map((option) => {
                      const detected = customAgents?.find(
                        (agent) => agent.id === option.id,
                      );
                      return (
                        <li
                          key={option.id}
                          data-testid="settings-custom-agent"
                          data-found={detected?.available ?? "checking"}
                          className="flex items-center gap-3 px-3 py-1.5 text-sm"
                        >
                          <span className="font-medium">{option.label}</span>
                          <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                            {detected?.command ?? option.id}
                          </code>
                          <span
                            className={cn(
                              "flex shrink-0 items-center gap-1 text-xs",
                              !detected
                                ? "text-muted-foreground"
                                : detected.available
                                  ? "text-status-ok"
                                  : "text-status-needsYou",
                            )}
                            title={detected?.path}
                          >
                            {!detected ? (
                              "Checking…"
                            ) : detected.available ? (
                              <>
                                <Check className="h-3 w-3" />
                                Found
                              </>
                            ) : (
                              <>
                                <X className="h-3 w-3" />
                                Not found
                              </>
                            )}
                          </span>
                        </li>
                      );
                    })}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Add or edit custom agents in{" "}
                <button
                  type="button"
                  data-testid="settings-custom-agents-edit"
                  className="text-foreground underline-offset-2 hover:text-primary hover:underline"
                  onClick={onEditConfig}
                >
                  config.json
                </button>
                .
              </p>
            </div>
          }
        />
      </SettingsCard>
    </div>
  );
}
