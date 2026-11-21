// One Settings row (docs/settings.md S5/S12) and the generic controls the
// page draws from core's settings description: boolean → Switch, integer →
// number field, string → text field (both commit on Enter or blur after
// validation; invalid → inline hint, nothing saved), enum / harness →
// select. Every described row carries the "changed" dot and reset-to-default
// (sends `null`) while its key is set in config.json, and shows a rejected
// write's message inline. `SettingRow` itself is presentational and shared
// with the onboarding wizard (its permission-bypass switch, S3).

import { ChevronDown, RotateCcw } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type {
  SettingDescription,
  SettingsSnapshot,
  SettingValue,
} from "../../../../preload/api";
import {
  type DraftResult,
  findSetting,
  isExplicit,
  isSameValue,
  parseIntegerDraft,
  parseStringDraft,
  valueText,
} from "../../lib/settings-form";
import type { SettingsModel } from "../../lib/use-settings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/** A bordered group of rows (design system "Cards": bg-card, hairline, radius). */
export function SettingsCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-border rounded-lg border border-border bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Title, help text and the control on the right. `changed` shows the dot
 * (S12); `onReset` the reset button (space is kept for it either way, so
 * controls stay aligned); `note` an extra muted line (e.g. "Overridden in
 * 2 repositories", S8); `error` a rejected value or a validation hint.
 */
export function SettingRow({
  title,
  help,
  children,
  changed = false,
  onReset,
  note,
  error,
  below,
  testId,
}: {
  title: string;
  help?: ReactNode;
  children?: ReactNode;
  changed?: boolean;
  onReset?: (() => void) | undefined;
  note?: ReactNode;
  error?: string | undefined;
  /** Full-width content under the row (e.g. a list). */
  below?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-changed={changed}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{title}</span>
            {changed && (
              <span
                data-testid="setting-changed"
                title="Changed from the default"
                role="img"
                aria-label="Changed from the default"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
          </div>
          {help && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">{help}</p>
          )}
          {note && (
            <p
              data-testid="setting-note"
              className="mt-1 text-xs text-muted-foreground"
            >
              {note}
            </p>
          )}
          {error && (
            <p
              role="alert"
              data-testid="setting-error"
              className="mt-1 text-xs text-status-error"
            >
              {error}
            </p>
          )}
        </div>
        {(children || onReset) && (
          <div className="flex shrink-0 items-center gap-1">
            {children}
            {onReset !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7 w-7 p-0", !changed && "invisible")}
                data-testid="setting-reset"
                title="Reset to default"
                aria-label={`Reset ${title} to default`}
                tabIndex={changed ? 0 : -1}
                onClick={onReset}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
      {below}
    </div>
  );
}

/**
 * A text / number field that commits on Enter or blur (S5). Esc reverts
 * the draft. Shows the stored value whenever it is not being edited, so a
 * hand edit of config.json shows up live.
 */
export function CommitField({
  value,
  parse,
  onCommit,
  onProblem,
  testId,
  label,
  className,
  placeholder,
  numeric = false,
  format = valueText,
  suffix,
}: {
  value: SettingValue | null | undefined;
  parse(text: string): DraftResult;
  /** The field text for a stored value (e.g. ms shown as minutes). */
  format?: (value: SettingValue | null | undefined) => string;
  /** A unit after the field (e.g. "min"). */
  suffix?: string | undefined;
  /** Resolves a rejection message, else `undefined`. */
  onCommit(value: SettingValue | null): Promise<string | undefined>;
  onProblem(problem: string | undefined): void;
  testId: string;
  label: string;
  className?: string;
  placeholder?: string | undefined;
  numeric?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState(format(value));
  const editing = useRef(false);
  const reverting = useRef(false);
  // A new stored value (a commit, a reset, a hand edit) replaces the field
  // text unless the user is mid-edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the stored value only.
  useEffect(() => {
    if (!editing.current) setDraft(format(value));
  }, [value]);

  const commit = (text: string): void => {
    const parsed = parse(text);
    if (!parsed.ok) {
      onProblem(parsed.hint);
      return;
    }
    onProblem(undefined);
    if (isSameValue(value, parsed.value)) {
      setDraft(format(value));
      return;
    }
    void onCommit(parsed.value).then((problem) => {
      onProblem(problem);
      if (!problem) setDraft(format(parsed.value));
    });
  };

  const input = (
    <Input
      data-testid={testId}
      aria-label={label}
      value={draft}
      spellCheck={false}
      placeholder={placeholder}
      inputMode={numeric ? "numeric" : undefined}
      className={cn(
        numeric ? "w-20 text-right tabular-nums" : "w-64",
        className,
      )}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(draft);
        } else if (event.key === "Escape") {
          reverting.current = true;
          setDraft(format(value));
          onProblem(undefined);
          event.currentTarget.blur();
        }
      }}
      onBlur={() => {
        editing.current = false;
        if (reverting.current) {
          reverting.current = false;
          return;
        }
        commit(draft);
      }}
    />
  );
  return suffix ? (
    <span className="flex items-center gap-1.5">
      {input}
      <span className="text-[13px] text-muted-foreground">{suffix}</span>
    </span>
  ) : (
    input
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** A select drawn as a secondary button with a radio menu (design system "Popovers / menus"). */
export function SelectField({
  value,
  options,
  onChange,
  testId,
  label,
}: {
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
  testId: string;
  label: string;
}): JSX.Element {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          data-testid={testId}
          data-value={value}
          aria-label={label}
          className="w-64 justify-between"
        >
          <span className="truncate">{current?.label ?? value}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 min-w-[12rem] overflow-y-auto"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              data-testid={`${testId}-option`}
              data-value={option.value}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Parse a field's draft by the setting's type. */
function draftParser(
  setting: SettingDescription,
): (text: string) => DraftResult {
  return setting.type === "integer"
    ? (text) => parseIntegerDraft(text, setting)
    : (text) => parseStringDraft(text, setting);
}

/** The control for one described setting, chosen by its type. */
function SettingControl({
  setting,
  snapshot,
  value,
  write,
  onProblem,
}: {
  setting: SettingDescription;
  snapshot: SettingsSnapshot;
  value: SettingValue | null | undefined;
  write(value: SettingValue | null): Promise<string | undefined>;
  onProblem(problem: string | undefined): void;
}): JSX.Element | null {
  const testId = `setting-input-${setting.key}`;
  const change = (next: SettingValue | null): void => {
    void write(next).then(onProblem);
  };
  switch (setting.type) {
    case "boolean":
      return (
        <Switch
          checked={value === true}
          onChange={(next) => change(next)}
          disabled={setting.uiReadOnly === true}
          testId={testId}
          label={setting.title}
        />
      );
    case "integer":
    case "string":
      return (
        <CommitField
          value={value}
          parse={draftParser(setting)}
          onCommit={write}
          onProblem={onProblem}
          testId={testId}
          label={setting.title}
          numeric={setting.type === "integer"}
          suffix={setting.unit === "minutes" ? "min" : undefined}
          placeholder={setting.default === null ? "Default" : undefined}
        />
      );
    case "enum":
      return (
        <SelectField
          value={valueText(value)}
          options={(setting.values ?? []).map((entry) => ({
            value: entry,
            label: setting.valueLabels?.[entry] ?? entry,
          }))}
          onChange={change}
          testId={testId}
          label={setting.title}
        />
      );
    case "harness": {
      const current = valueText(value);
      const options = snapshot.harnesses.map((option) => ({
        value: option.id,
        label: option.custom ? `${option.label} (custom)` : option.label,
      }));
      // A configured id no agent answers to stays visible, never swapped.
      if (current && !options.some((option) => option.value === current)) {
        options.push({ value: current, label: `${current} (not found)` });
      }
      return (
        <SelectField
          value={current}
          options={options}
          onChange={change}
          testId={testId}
          label={setting.title}
        />
      );
    }
  }
}

/**
 * A row for the described setting `settingKey`: title and help from the
 * description, a control by type (or `control` instead), changed dot +
 * reset, inline errors. `accessory` sits beside the control (e.g.
 * "Choose…"); `note` and `below` pass through to `SettingRow`.
 */
export function DescribedSetting({
  model,
  snapshot,
  settingKey,
  control,
  accessory,
  note,
  below,
}: {
  model: Pick<SettingsModel, "update">;
  snapshot: SettingsSnapshot;
  settingKey: string;
  /** Replaces the generic control; receives the write + problem plumbing. */
  control?: (props: {
    value: SettingValue | null | undefined;
    write(value: SettingValue | null): Promise<string | undefined>;
    onProblem(problem: string | undefined): void;
  }) => ReactNode;
  accessory?: (props: {
    write(value: SettingValue | null): Promise<string | undefined>;
    onProblem(problem: string | undefined): void;
  }) => ReactNode;
  note?: ReactNode;
  below?: ReactNode;
}): JSX.Element | null {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const setting = findSetting(snapshot, settingKey);
  const value = snapshot.values[settingKey];
  // A new stored value (from anywhere) clears a stale rejection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the stored value only.
  useEffect(() => {
    setProblem(undefined);
  }, [value]);
  if (!setting) return null;
  const write = (next: SettingValue | null): Promise<string | undefined> =>
    model.update(settingKey, next);
  const changed = isExplicit(snapshot, settingKey);
  return (
    <SettingRow
      testId={`setting-row-${settingKey}`}
      title={setting.title}
      help={setting.help}
      changed={changed}
      onReset={
        setting.uiReadOnly
          ? undefined
          : () => {
              void write(null).then(setProblem);
            }
      }
      note={note}
      error={problem}
      below={below}
    >
      {control ? (
        control({ value, write, onProblem: setProblem })
      ) : (
        <SettingControl
          setting={setting}
          snapshot={snapshot}
          value={value}
          write={write}
          onProblem={setProblem}
        />
      )}
      {accessory?.({ write, onProblem: setProblem })}
    </SettingRow>
  );
}
