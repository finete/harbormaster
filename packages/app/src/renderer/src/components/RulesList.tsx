// The Rules tab's body (docs/rules-page.md decisions 2, 4, 9, 11, 12):
// rules as two-line rows grouped by file under the four fixed header
// strings, plus the three degenerate states (rules off, no files, only
// broken files). Purely presentational (props in, callbacks out, no window
// access) so the states render under plain vitest
// (tests/rules-list.test.ts); RulesView.tsx owns data and selection.
import { AlertTriangle, ArrowRight, FileCode2, ListChecks } from "lucide-react";
import type { JSX } from "react";
import type { Rule, RuleFile, RulesListing } from "../../../preload/api";
import {
  DOT_CLASS,
  DOT_TITLE,
  doChipText,
  fileHeaderKind,
  fileHeaderSegments,
  lastFiredText,
  onChips,
  problemLine,
  type RuleKey,
  ruleDot,
  ruleKeyString,
  rulesPageState,
} from "../lib/rules-format";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export const RULES_OFF_BANNER =
  "Rules are turned off — they're loaded but never run.";
export const ONLY_BROKEN_HINT =
  "Nothing is loaded. Fix the problem above and the rules will reload on the next refresh.";
export const NO_RULES_FOLDER_TITLE =
  "The rules folder is not known until a rules file exists";

export interface RulesListProps {
  listing: RulesListing;
  /** Display label for a repository id (`repos/<repo>.yaml` headers). */
  repoLabel: (repositoryId: string) => string;
  selected: string | null;
  now: number;
  onSelect: (key: RuleKey) => void;
  /** Open a rules file in the default open-in app (only-broken hint). */
  onOpenFile: (path: string) => void;
  /** Open the rules folder; absent = its location is unknown (button disabled). */
  onOpenFolder?: (() => void) | undefined;
  /** Write the shipped defaults; absent = not available (button disabled). */
  onRestoreDefaults?: (() => void) | undefined;
  onTurnOn: () => void;
}

export function RulesList(props: RulesListProps): JSX.Element {
  const { listing } = props;
  const state = rulesPageState(listing.files);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="rules-list"
      data-state={state}
    >
      {!listing.enabled && (
        <div
          role="status"
          data-testid="rules-off-banner"
          className="mx-3 mt-3 flex items-center gap-3 rounded-lg border border-status-needsYou/45 bg-status-needsYou/15 px-3 py-2 text-sm text-status-needsYou"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1">{RULES_OFF_BANNER}</span>
          <Button
            size="sm"
            variant="secondary"
            data-testid="rules-turn-on"
            onClick={props.onTurnOn}
          >
            Turn on
          </Button>
        </div>
      )}
      <div
        className={cn(
          "flex flex-col gap-4 py-3",
          !listing.enabled && "opacity-60",
        )}
        data-dimmed={!listing.enabled || undefined}
      >
        {state === "no-files" ? (
          <NoFiles {...props} />
        ) : (
          listing.files.map((file) => (
            <FileGroup key={file.file} file={file} {...props} />
          ))
        )}
        {state === "only-broken" && (
          <div
            data-testid="rules-only-broken"
            className="mx-3 flex items-center gap-3 text-sm text-muted-foreground"
          >
            <span className="flex-1">{ONLY_BROKEN_HINT}</span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="rules-only-broken-open"
              disabled={!listing.files[0]?.path}
              onClick={() => {
                const path = listing.files[0]?.path;
                if (path) props.onOpenFile(path);
              }}
            >
              <FileCode2 aria-hidden />
              Open in editor
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoFiles({
  onOpenFolder,
  onRestoreDefaults,
}: RulesListProps): JSX.Element {
  return (
    <div
      data-testid="rules-empty"
      className="flex flex-col items-center gap-3 px-6 py-16 text-center"
    >
      <ListChecks className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">No rules files</p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          data-testid="rules-restore-defaults"
          disabled={!onRestoreDefaults}
          onClick={onRestoreDefaults}
        >
          Restore defaults
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="rules-empty-open-folder"
          disabled={!onOpenFolder}
          title={onOpenFolder ? undefined : NO_RULES_FOLDER_TITLE}
          onClick={onOpenFolder}
        >
          Open rules folder
        </Button>
      </div>
    </div>
  );
}

function FileGroup({
  file,
  repoLabel,
  selected,
  now,
  onSelect,
}: RulesListProps & { file: RuleFile }): JSX.Element {
  const broken = file.problems.length > 0;
  const kind = fileHeaderKind(file);
  const segments = fileHeaderSegments(
    file,
    file.repositoryId ? repoLabel(file.repositoryId) : "",
  );
  return (
    <section
      data-testid={`rules-file-${file.file}`}
      data-header={kind}
      className="flex flex-col gap-1.5"
    >
      <header
        className={cn(
          "mx-3 flex items-start gap-2 border-l-2 pl-2",
          broken ? "border-status-error" : "border-transparent",
        )}
      >
        <div className="min-w-0 flex-1">
          <div
            className="text-[13px] text-muted-foreground"
            data-testid="rules-file-header"
          >
            <span className="font-medium text-foreground">{file.file}</span>{" "}
            {segments.map((segment) =>
              segment.strong ? (
                <strong
                  key={segment.text}
                  className={cn(
                    "font-semibold",
                    broken ? "text-status-error" : "text-foreground",
                  )}
                >
                  {segment.text}
                </strong>
              ) : (
                <span key={segment.text}>{segment.text}</span>
              ),
            )}
          </div>
          {file.path && (
            <div className="truncate font-mono text-[11px] text-muted-foreground/80">
              {file.path}
            </div>
          )}
          {broken && (
            <ul
              data-testid="rules-file-problems"
              className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-status-error"
            >
              {file.problems.map((problem) => (
                <li key={problem}>{problemLine(problem, file.file)}</li>
              ))}
            </ul>
          )}
        </div>
      </header>
      {file.rules.map((rule) => {
        const key = ruleKeyString({ file: rule.file, ruleId: rule.id });
        return (
          <RuleRow
            key={key}
            rule={rule}
            rowKey={key}
            selected={selected === key}
            now={now}
            onSelect={() => onSelect({ file: rule.file, ruleId: rule.id })}
          />
        );
      })}
    </section>
  );
}

const CHIP =
  "inline-flex max-w-[16rem] items-center truncate rounded-md border border-border bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground";

function RuleRow({
  rule,
  rowKey,
  selected,
  now,
  onSelect,
}: {
  rule: Rule;
  rowKey: string;
  selected: boolean;
  now: number;
  onSelect: () => void;
}): JSX.Element {
  const dot = ruleDot(rule.activity);
  const on = onChips(rule.on);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a block-level div keeps the two-line row layout (matches the inbox rows).
    <div
      role="button"
      tabIndex={-1}
      data-testid={`rule-row-${rowKey}`}
      data-rule-key={rowKey}
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={() => {}}
      className={cn(
        "relative mx-3 flex cursor-default flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 outline-none transition-colors duration-[120ms] ease-out hover:border-foreground/20",
        selected && "border-primary hover:border-primary",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          data-testid="rule-dot"
          data-dot={dot}
          title={DOT_TITLE[dot]}
          className={cn("h-2 w-2 shrink-0 rounded-full", DOT_CLASS[dot])}
        />
        <span
          className="min-w-0 flex-1 truncate text-sm"
          data-testid="rule-label"
        >
          {rule.label}
        </span>
        <span
          className="shrink-0 text-[11px] text-muted-foreground"
          title={rule.activity?.lastAt}
          data-testid="rule-last-fired"
        >
          {lastFiredText(rule.activity, now)}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {on.shown.map((glob) => (
          <span key={glob} className={CHIP} title={glob}>
            {glob}
          </span>
        ))}
        {on.more > 0 && (
          <span className={CHIP} title={rule.on.slice(2).join("\n")}>
            +{on.more}
          </span>
        )}
        <ArrowRight
          className="h-3 w-3 shrink-0 text-muted-foreground"
          aria-hidden
        />
        {rule.do.map((spec, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: actions are positional.
            key={index}
            className={cn(CHIP, "text-foreground")}
            data-testid="rule-do-chip"
          >
            {doChipText(spec)}
          </span>
        ))}
      </div>
    </div>
  );
}
