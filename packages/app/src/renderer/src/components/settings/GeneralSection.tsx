// Settings → General (docs/settings.md "Settings in v1"): code folder (with
// the same folder picker the wizard's code step uses), branch prefix,
// terminal font size, desktop notifications (S11), and the automation state read-only with a link to
// the Rules page, where its switch lives (S13).

import { FolderOpen } from "lucide-react";
import type { JSX } from "react";
import type { SettingsSnapshot } from "../../../../preload/api";
import { automationLine, findSetting } from "../../lib/settings-form";
import type { SettingsModel } from "../../lib/use-settings";
import { Button } from "../ui/button";
import { DescribedSetting, SettingRow, SettingsCard } from "./SettingRow";

export function GeneralSection({
  model,
  snapshot,
  onOpenRules,
}: {
  model: Pick<SettingsModel, "update">;
  snapshot: SettingsSnapshot;
  onOpenRules(): void;
}): JSX.Element {
  const automation = findSetting(snapshot, "automation");
  return (
    <SettingsCard>
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="codeRoot"
        accessory={({ write, onProblem }) => (
          <Button
            variant="secondary"
            size="sm"
            className="ml-1"
            data-testid="settings-choose-code-root"
            onClick={async () => {
              const picked = await window.harbormaster.app.pickFolder();
              if (picked) onProblem(await write(picked));
            }}
          >
            <FolderOpen />
            Choose…
          </Button>
        )}
      />
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="branchPrefix"
      />
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="terminal.fontSize"
      />
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="terminal.screenReader"
      />
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="notifications.enabled"
      />
      <SettingRow
        testId="setting-row-automation"
        title={automation?.title ?? "Automation"}
        help="Whether board rules run. The switch is on the Rules page."
      >
        <span
          data-testid="settings-automation-state"
          className="text-[13px] text-muted-foreground"
        >
          {automationLine(snapshot.values.automation !== false)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="settings-manage-rules"
          onClick={onOpenRules}
        >
          Manage rules →
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}
