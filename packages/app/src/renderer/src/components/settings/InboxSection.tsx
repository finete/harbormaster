// Settings → Inbox & messaging (docs/settings.md "Settings in v1"): the
// parent reply timeout and the message loop cap as described rows, and the
// inbox priority filter, a CEL expression that stays in config.json (S1):
// the row only says whether a custom filter is set.

import { FileJson } from "lucide-react";
import type { JSX } from "react";
import type { SettingsSnapshot } from "../../../../preload/api";
import {
  findSetting,
  isExplicit,
  priorityFilterLine,
} from "../../lib/settings-form";
import type { SettingsModel } from "../../lib/use-settings";
import { Button } from "../ui/button";
import { DescribedSetting, SettingRow, SettingsCard } from "./SettingRow";

export function InboxSection({
  model,
  snapshot,
  onEditConfig,
}: {
  model: Pick<SettingsModel, "update">;
  snapshot: SettingsSnapshot;
  onEditConfig(): void;
}): JSX.Element {
  const filter = findSetting(snapshot, "inbox.priorityFilter");
  const filterValue = snapshot.values["inbox.priorityFilter"];
  return (
    <SettingsCard>
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="messaging.parentReplyTimeoutMinutes"
      />
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="messaging.loopCap"
      />
      <SettingRow
        testId="setting-row-inbox.priorityFilter"
        title={`Inbox ${(filter?.title ?? "Priority filter").toLowerCase()}`}
        help={filter?.help}
        changed={isExplicit(snapshot, "inbox.priorityFilter")}
        note={
          <span data-testid="settings-priority-filter-state">
            {priorityFilterLine(filterValue)}
            {typeof filterValue === "string" && filterValue.trim() ? (
              <>
                {": "}
                <code className="break-all rounded bg-muted px-1 font-mono text-[11px] text-foreground">
                  {filterValue}
                </code>
              </>
            ) : null}
          </span>
        }
      >
        <Button
          variant="secondary"
          size="sm"
          data-testid="settings-priority-filter-edit"
          onClick={onEditConfig}
        >
          <FileJson />
          Edit in config.json
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}
