// Settings → GitHub & sources (docs/settings.md S10): a hand-made GitHub
// panel (the `gh` account the wizard's GitHub step reads, with Recheck; the
// github source on/off; review-request / mention watching; the search
// interval shown in minutes, stored in ms) and, for every add-on source,
// an on/off switch plus a form drawn from its `settingsSchema`. Writes go
// through `updateSettings` (`sources.<id>.enabled` /
// `sources.<id>.settings.<property>`), which core checks against the
// source's own schema.

import { CheckCircle2, FileJson, RefreshCw } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import type {
  GithubAuthStatus,
  SettingsSnapshot,
  SettingsSource,
  SettingValue,
} from "../../../../preload/api";
import {
  autoFormSources,
  findSetting,
  ipcErrorText,
  msToMinutes,
  parseMinutesDraft,
  parseSourceNumberDraft,
  parseSourceTextDraft,
  type SourceField,
  sourceFieldValue,
  sourceFormFields,
  sourceSettingKey,
  valueText,
} from "../../lib/settings-form";
import type { SettingsModel } from "../../lib/use-settings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  CommitField,
  DescribedSetting,
  SelectField,
  SettingRow,
  SettingsCard,
} from "./SettingRow";

/** `gh auth status`, as the wizard's GitHub step reads it; `recheck` re-runs it. */
function useGithubAuth(): {
  status: GithubAuthStatus | null;
  recheck(): void;
} {
  const [status, setStatus] = useState<GithubAuthStatus | null>(null);
  const recheck = useCallback(() => {
    setStatus(null);
    window.harbormaster.onboarding
      .githubAuthStatus()
      .then(setStatus)
      .catch((error: unknown) =>
        setStatus({
          installed: false,
          authenticated: false,
          error: ipcErrorText(error),
        }),
      );
  }, []);
  useEffect(() => recheck(), [recheck]);
  return { status, recheck };
}

function AccountStatus({
  status,
}: {
  status: GithubAuthStatus | null;
}): JSX.Element {
  if (!status) {
    return (
      <span data-testid="settings-github-account" data-state="checking">
        Checking gh auth status…
      </span>
    );
  }
  if (status.authenticated) {
    return (
      <span
        data-testid="settings-github-account"
        data-state="connected"
        className="inline-flex items-center gap-1.5 text-foreground"
      >
        <CheckCircle2 className="h-3.5 w-3.5 text-status-ok" />
        <span>
          Connected
          {status.account ? (
            <>
              {" "}
              as <span className="font-medium">{status.account}</span>
            </>
          ) : null}
          {status.host && status.host !== "github.com"
            ? ` (${status.host})`
            : ""}
        </span>
      </span>
    );
  }
  return (
    <span data-testid="settings-github-account" data-state="signed-out">
      <span className="text-status-needsYou">
        {status.installed
          ? "gh is not signed in."
          : "The GitHub CLI (gh) is not installed."}
      </span>{" "}
      {status.installed ? (
        <>
          Run <code className="rounded bg-muted px-1">gh auth login</code> in a
          terminal, then Recheck.
        </>
      ) : (
        <>
          Install it (
          <code className="rounded bg-muted px-1">brew install gh</code>), run{" "}
          <code className="rounded bg-muted px-1">gh auth login</code>, then
          Recheck.
        </>
      )}
    </span>
  );
}

function GithubPanel({
  model,
  snapshot,
}: {
  model: Pick<SettingsModel, "update">;
  snapshot: SettingsSnapshot;
}): JSX.Element {
  const { status, recheck } = useGithubAuth();
  const interval = findSetting(
    snapshot,
    "sources.github.settings.searchIntervalMs",
  );
  const github = snapshot.sources?.find((source) => source.id === "github");
  return (
    <SettingsCard>
      <SettingRow
        testId="setting-row-github-account"
        title="GitHub account"
        help={<AccountStatus status={status} />}
        note="Harbormaster uses the GitHub CLI (gh) you are signed in to."
      >
        <Button
          variant="secondary"
          size="sm"
          data-testid="settings-github-recheck"
          disabled={!status}
          onClick={recheck}
        >
          <RefreshCw />
          Recheck
        </Button>
      </SettingRow>
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="sources.github.enabled"
        note={
          github?.problems.length
            ? `Off until config.json is fixed: ${github.problems.join("; ")}`
            : undefined
        }
      />
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="sources.github.settings.watchReviewRequests"
      />
      <DescribedSetting
        model={model}
        snapshot={snapshot}
        settingKey="sources.github.settings.watchMentions"
      />
      {interval && (
        <DescribedSetting
          model={model}
          snapshot={snapshot}
          settingKey={interval.key}
          control={({ value, write, onProblem }) => (
            <CommitField
              value={value}
              format={(stored) => valueText(msToMinutes(stored))}
              parse={(text) => parseMinutesDraft(text, interval)}
              onCommit={write}
              onProblem={onProblem}
              testId={`setting-input-${interval.key}`}
              label={`${interval.title} (minutes)`}
              numeric
              suffix="min"
            />
          )}
        />
      )}
    </SettingsCard>
  );
}

/** One schema property of an add-on source as a row (changed dot + reset like described rows). */
function SourceFieldRow({
  model,
  source,
  field,
  onEditConfig,
}: {
  model: Pick<SettingsModel, "update">;
  source: SettingsSource;
  field: SourceField;
  onEditConfig(): void;
}): JSX.Element {
  const key = sourceSettingKey(source.id, field.name);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const value = sourceFieldValue(source, field);
  // A new stored value (from anywhere) clears a stale rejection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the stored value only.
  useEffect(() => {
    setProblem(undefined);
  }, [value]);
  const changed = source.explicit.includes(field.name);
  const write = (next: SettingValue | null): Promise<string | undefined> =>
    model.update(key, next);
  const change = (next: SettingValue | null): void => {
    void write(next).then(setProblem);
  };
  const testId = `setting-input-${key}`;
  let control: JSX.Element;
  switch (field.kind) {
    case "boolean":
      control = (
        <Switch
          checked={value === true}
          onChange={(next) => change(next)}
          testId={testId}
          label={field.label}
        />
      );
      break;
    case "integer":
    case "number":
      control = (
        <CommitField
          value={value}
          parse={(text) => parseSourceNumberDraft(text, field)}
          onCommit={write}
          onProblem={setProblem}
          testId={testId}
          label={field.label}
          numeric
        />
      );
      break;
    case "string":
      control = (
        <CommitField
          value={value}
          parse={parseSourceTextDraft}
          onCommit={write}
          onProblem={setProblem}
          testId={testId}
          label={field.label}
          placeholder={field.default === undefined ? "Not set" : undefined}
        />
      );
      break;
    case "enum": {
      const current = valueText(value);
      const options = field.values.map((entry) => ({
        value: entry,
        label: entry,
      }));
      if (!current) options.unshift({ value: "", label: "Not set" });
      else if (!field.values.includes(current)) {
        options.push({ value: current, label: `${current} (not allowed)` });
      }
      control = (
        <SelectField
          value={current}
          options={options}
          onChange={(next) => change(next === "" ? null : next)}
          testId={testId}
          label={field.label}
        />
      );
      break;
    }
    case "file":
      control = (
        <Button
          variant="secondary"
          size="sm"
          data-testid={testId}
          onClick={onEditConfig}
        >
          <FileJson />
          Edit in config.json
        </Button>
      );
      break;
  }
  return (
    <SettingRow
      testId={`setting-row-${key}`}
      title={field.label}
      help={field.help}
      changed={changed}
      onReset={
        field.kind === "file"
          ? undefined
          : () => {
              void write(null).then(setProblem);
            }
      }
      error={problem}
    >
      {control}
    </SettingRow>
  );
}

function AddonSourceCard({
  model,
  source,
  onEditConfig,
}: {
  model: Pick<SettingsModel, "update">;
  source: SettingsSource;
  onEditConfig(): void;
}): JSX.Element {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const enabledKey = sourceSettingKey(source.id);
  const fields = sourceFormFields(source.settingsSchema);
  const origin = source.addon
    ? `From the add-on ${source.addon.name}${
        source.addon.description ? `: ${source.addon.description}` : ""
      }`
    : "Built in";
  return (
    <SettingsCard>
      <div data-testid={`settings-source-${source.id}`}>
        <SettingRow
          testId={`setting-row-${enabledKey}`}
          title={source.label}
          help={origin}
          note={
            source.problems.length
              ? `Off until config.json is fixed: ${source.problems.join("; ")}`
              : undefined
          }
          changed={source.enabledExplicit}
          onReset={() => {
            void model.update(enabledKey, null).then(setProblem);
          }}
          error={problem}
        >
          <Switch
            checked={source.enabled}
            onChange={(next) => {
              void model.update(enabledKey, next).then(setProblem);
            }}
            testId={`setting-input-${enabledKey}`}
            label={`${source.label} on/off`}
          />
        </SettingRow>
      </div>
      {fields.map((field) => (
        <SourceFieldRow
          key={field.name}
          model={model}
          source={source}
          field={field}
          onEditConfig={onEditConfig}
        />
      ))}
    </SettingsCard>
  );
}

export function GithubSection({
  model,
  snapshot,
  onEditConfig,
}: {
  model: Pick<SettingsModel, "update">;
  snapshot: SettingsSnapshot;
  onEditConfig(): void;
}): JSX.Element {
  const addons = autoFormSources(snapshot.sources);
  return (
    <div className="flex flex-col gap-4">
      <GithubPanel model={model} snapshot={snapshot} />
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Add-on sources
      </h3>
      {addons.length === 0 ? (
        <p
          data-testid="settings-no-addon-sources"
          className="text-[13px] text-muted-foreground"
        >
          No add-on sources installed. Add-ons live in the addons folder next to
          config.json; their options show up here.
        </p>
      ) : (
        addons.map((source) => (
          <AddonSourceCard
            key={source.id}
            model={model}
            source={source}
            onEditConfig={onEditConfig}
          />
        ))
      )}
    </div>
  );
}
