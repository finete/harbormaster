// The first-run wizard (docs/release-plan.md "Onboarding (four screens)",
// R14): code root + repositories, default agent, GitHub, concepts. One
// centered card (stepper on the left, the step on the right, Back and the
// primary button in the card's own footer), shown as the whole window
// before the normal UI on first run, and over it from the "Welcome /
// Setup…" menu item. Keyboard: Enter = primary (unless the focused control
// uses Enter), Cmd/Ctrl+Enter = primary always, Esc = Back (on the first
// step it closes the menu-opened overlay; first run ignores it).
//
// Every read and write is a core command through
// `window.harbormaster.onboarding` (main forwards; the renderer never
// touches the filesystem or a CLI). Probes resolve asynchronously with
// timeouts in core, so nothing here blocks on them.

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Columns3,
  FolderOpen,
  Inbox,
  MessagesSquare,
  RefreshCw,
  Scale,
  X,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodeRootScan,
  DetectedAgent,
  GithubAuthStatus,
  OnboardingState,
} from "../../../preload/api";
import {
  AGENT_INSTALL_HINTS,
  type AgentChoice,
  agentFoundLine,
  BUILTIN_AGENT_IDS,
  initialAgentChoice,
  isBuiltinAgent,
  ONBOARDING_STEPS,
  wizardKeyAction,
} from "../lib/onboarding";
import { modKeyLabel } from "../lib/platform";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Label } from "./ui/label";

const STEP_COUNT = ONBOARDING_STEPS.length;

/** What "Start" hands back: the Where the first task's composer preselects. */
export interface OnboardingResult {
  /** A composer Where token (`repo:<id>` / `folder:<path>`), when one was picked. */
  where?: string;
}

interface OnboardingProps {
  /** Shown from the menu over a running app: offers a close button (and Esc on step 1). */
  closable: boolean;
  onFinish(result: OnboardingResult): void;
  onClose(): void;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Electron prefixes rejected IPC handlers with "Error invoking remote method '…': Error: ".
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** The Harbormaster lighthouse (mirrors packages/app/build/logo-glyph.svg). */
export function LogoGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 128 128"
      fill="none"
      stroke="currentColor"
      strokeWidth={10}
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M50 44 L78 44 L90 112 L38 112 Z" />
      <path d="M38 80 L90 80" />
      <circle cx="64" cy="32" r="11" fill="#ffc34d" stroke="none" />
      <path
        d="M14 122 C30 114 46 114 62 122 S94 130 114 122"
        stroke="#6ef5d6"
      />
    </svg>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  testId,
  label,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  testId: string;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[120ms] ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full transition-transform duration-[120ms] ease-out",
          checked ? "bg-primary-foreground" : "bg-muted-foreground",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** Title (the stepper's label) and the one-sentence why under it. */
function StepHeader({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <h2
        id="onboarding-title"
        data-testid="onboarding-title"
        className="text-lg font-semibold"
      >
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** `~/…` for display when `path` is under the suggested root's home. */
function tildePath(path: string, suggested: string): string {
  const home = suggested.replace(/\/Code$/, "");
  return home && path.startsWith(`${home}/`)
    ? `~/${path.slice(home.length + 1)}`
    : path;
}

// --- The stepper -------------------------------------------------------------

function Stepper({
  step,
  disabled,
  onGo,
}: {
  step: number;
  disabled: boolean;
  onGo(index: number): void;
}): JSX.Element {
  return (
    <ol data-testid="onboarding-stepper" className="flex flex-col gap-1">
      {ONBOARDING_STEPS.map((entry, index) => {
        const state =
          index < step ? "done" : index === step ? "current" : "future";
        const marker = (
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
              state === "done" &&
                "border-primary/50 bg-primary/15 text-primary",
              state === "current" &&
                "border-primary bg-primary text-primary-foreground",
              state === "future" && "border-border text-muted-foreground",
            )}
          >
            {state === "done" ? (
              <Check
                data-testid="onboarding-step-check"
                className="h-3.5 w-3.5"
                strokeWidth={3}
              />
            ) : (
              index + 1
            )}
          </span>
        );
        const body = (
          <>
            {marker}
            <span className="min-w-0 text-left leading-tight">
              {entry.label}
            </span>
          </>
        );
        return (
          <li
            key={entry.id}
            data-testid="onboarding-stepper-step"
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            {state === "done" ? (
              <button
                type="button"
                disabled={disabled}
                title={`Back to "${entry.label}"`}
                onClick={() => onGo(index)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground/80 transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {body}
              </button>
            ) : (
              <div
                className={cn(
                  "flex items-center gap-2.5 px-2 py-1.5 text-sm",
                  state === "current"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// --- Screen 1: code root + repositories ------------------------------------

interface ExtraFolder {
  path: string;
  name: string;
  repositoryId?: string;
}

function CodeStep({
  state,
  root,
  onRootChange,
  scan,
  scanning,
  extras,
  onAddFolder,
  preselect,
  onPreselect,
  onUseSuggested,
}: {
  state: OnboardingState;
  root: string;
  onRootChange(root: string): void;
  scan: CodeRootScan | null;
  scanning: boolean;
  extras: ExtraFolder[];
  onAddFolder(): void;
  preselect: string;
  onPreselect(where: string): void;
  onUseSuggested(): void;
}): JSX.Element {
  const rows = [
    ...(scan?.repositories ?? []).map((repo) => ({
      key: `repo:${repo.id}`,
      name: repo.name,
      detail: repo.id,
    })),
    ...extras.map((folder) => ({
      key: folder.repositoryId
        ? `repo:${folder.repositoryId}`
        : `folder:${folder.path}`,
      name: folder.name,
      detail: folder.path,
    })),
  ];
  // Keep the selected row in view (a long list scrolls).
  const listRef = useRef<HTMLDivElement>(null);
  const rowCount = rows.length;
  useEffect(() => {
    if (!preselect || rowCount === 0) return;
    listRef.current
      ?.querySelector('[data-checked="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [preselect, rowCount]);
  return (
    <div className="flex flex-col gap-4">
      <StepHeader title={ONBOARDING_STEPS[0].label}>
        Harbormaster finds every git repository directly under this folder. Each
        task gets its own worktree inside it.
      </StepHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-code-root">Code folder</Label>
        <div className="flex gap-2">
          <Input
            id="onboarding-code-root"
            data-testid="onboarding-code-root"
            data-path-input="true"
            value={root}
            spellCheck={false}
            onChange={(event) => onRootChange(event.target.value)}
          />
          <Button
            variant="secondary"
            data-testid="onboarding-choose-root"
            onClick={async () => {
              const picked = await window.harbormaster.app.pickFolder();
              if (picked) onRootChange(picked);
            }}
          >
            <FolderOpen className="h-4 w-4" />
            Choose…
          </Button>
        </div>
      </div>
      {scan?.protectedFolder && (
        <div
          data-testid="onboarding-protected-warning"
          className="flex items-start gap-3 rounded-lg border border-status-needsYou/40 bg-status-needsYou/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-needsYou" />
          <div className="flex-1">
            <p>
              macOS ties folder permissions to this unsigned build; you may be
              asked again after each upgrade. A plain folder like ~/Code never
              asks.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              data-testid="onboarding-use-code"
              onClick={onUseSuggested}
            >
              Use {tildePath(scan.suggestedRoot, state.suggestedCodeRoot)}{" "}
              instead
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label id="onboarding-repos-label">Repositories found</Label>
          {scanning && (
            <span className="text-xs text-muted-foreground">Scanning…</span>
          )}
        </div>
        {scan && !scan.exists ? (
          <p
            data-testid="onboarding-root-missing"
            className="text-sm text-muted-foreground"
          >
            This folder does not exist yet.
          </p>
        ) : rows.length === 0 && !scanning ? (
          <p
            data-testid="onboarding-no-repos"
            className="text-sm text-muted-foreground"
          >
            No git repositories directly under this folder yet. Clone one there,
            or add a folder below.
          </p>
        ) : (
          <div
            ref={listRef}
            role="radiogroup"
            aria-labelledby="onboarding-repos-label"
            data-testid="onboarding-repo-list"
            // Six 2rem rows, then it scrolls.
            className="flex max-h-[12.25rem] flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card"
          >
            {rows.map((row) => {
              const checked = preselect === row.key;
              return (
                <label
                  key={row.key}
                  data-testid="onboarding-repo"
                  data-checked={checked}
                  data-where={row.key}
                  className={cn(
                    "flex h-8 shrink-0 cursor-pointer items-center gap-2.5 px-3 text-sm transition-colors duration-[120ms] ease-out",
                    checked ? "bg-primary/10" : "hover:bg-accent",
                  )}
                >
                  <input
                    type="radio"
                    name="onboarding-repo"
                    checked={checked}
                    onChange={() => onPreselect(row.key)}
                    className="h-3.5 w-3.5 shrink-0 accent-primary"
                  />
                  <span className="shrink-0 font-semibold">{row.name}</span>
                  {/* rtl + an LRM pair truncates from the start, so the org/repo end stays visible. */}
                  <span
                    dir="rtl"
                    title={row.detail}
                    className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground"
                  >
                    {`\u200e${row.detail}\u200e`}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {rows.length > 0
              ? "The selected one is preselected for your first task."
              : ""}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            data-testid="onboarding-add-folder"
            onClick={onAddFolder}
          >
            Add another folder…
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Screen 2: default agent -------------------------------------------------

const AGENT_LABELS: Record<(typeof BUILTIN_AGENT_IDS)[number], string> = {
  pi: "Pi",
  "claude-code": "Claude Code",
};

function AgentCard({
  id,
  label,
  checked,
  onSelect,
  children,
}: {
  id: string;
  label: string;
  checked: boolean;
  onSelect(): void;
  children: ReactNode;
}): JSX.Element {
  return (
    <label
      data-testid={`onboarding-agent-${id}`}
      data-checked={checked}
      className={cn(
        // Radio card (design system "Cards"): bg-card, hairline, radius;
        // selected = border-primary, hover = border-foreground/20.
        "flex w-full cursor-pointer items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors duration-[120ms] ease-out",
        checked ? "border-primary" : "border-border hover:border-foreground/20",
      )}
    >
      <input
        type="radio"
        name="onboarding-agent"
        value={id}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        {children}
      </span>
    </label>
  );
}

function AgentStep({
  state,
  detected,
  detecting,
  onRescan,
  choice,
  onChoice,
  bypass,
  onBypass,
}: {
  state: OnboardingState;
  detected: DetectedAgent[] | null;
  detecting: boolean;
  onRescan(): void;
  choice: AgentChoice;
  onChoice(choice: AgentChoice): void;
  bypass: boolean;
  onBypass(bypass: boolean): void;
}): JSX.Element {
  const agent = (id: string) => detected?.find((entry) => entry.id === id);
  const display = (path: string) => tildePath(path, state.suggestedCodeRoot);
  // A custom agent (config.json) that already is the default stays
  // pickable, so reopening the wizard never silently replaces it.
  const configuredCustom = isBuiltinAgent(state.defaultHarness)
    ? undefined
    : state.customAgents.find((entry) => entry.id === state.defaultHarness);
  const chosen = isBuiltinAgent(choice) ? agent(choice) : undefined;
  const piInPlay = choice === "pi" || agent("pi")?.available;
  return (
    <div className="flex flex-col gap-4">
      <StepHeader title={ONBOARDING_STEPS[1].label}>
        Harbormaster runs the agent you already use; pick the one new tasks
        start with.
      </StepHeader>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label id="onboarding-agents-label">Agents on this machine</Label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            data-testid="onboarding-agent-rescan"
            disabled={detecting}
            onClick={onRescan}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", detecting && "animate-spin")}
            />
            Rescan
          </Button>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="onboarding-agents-label"
          data-testid="onboarding-agent-options"
          className="flex flex-col gap-2"
        >
          {BUILTIN_AGENT_IDS.map((id) => {
            const found = agent(id);
            const line = found ? agentFoundLine(found, display) : undefined;
            return (
              <AgentCard
                key={id}
                id={id}
                label={AGENT_LABELS[id]}
                checked={choice === id}
                onSelect={() => onChoice(id)}
              >
                <span
                  data-testid={`onboarding-agent-${id}-status`}
                  className={cn(
                    "truncate text-xs",
                    line ? "text-status-ok" : "text-muted-foreground",
                  )}
                  title={found?.path ?? found?.command}
                >
                  {!found ? "Detecting…" : (line ?? found.error ?? "not found")}
                </span>
                {found && !found.available && (
                  <span
                    data-testid={`onboarding-agent-${id}-install`}
                    className="text-xs text-muted-foreground"
                  >
                    Install:{" "}
                    <code className="select-all rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">
                      {AGENT_INSTALL_HINTS[id]}
                    </code>
                  </span>
                )}
              </AgentCard>
            );
          })}
          {configuredCustom && (
            <AgentCard
              id="configured"
              label={`Keep ${configuredCustom.label}`}
              checked={choice === configuredCustom.id}
              onSelect={() => onChoice(configuredCustom.id)}
            >
              <span className="text-xs text-muted-foreground">
                Your current default, a custom agent from config.json.
              </span>
            </AgentCard>
          )}
        </div>
      </div>
      {chosen && !chosen.available && (
        <p
          data-testid="onboarding-agent-warning"
          className="flex items-start gap-2 text-xs text-status-needsYou"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {AGENT_LABELS[chosen.id as keyof typeof AGENT_LABELS] ?? chosen.label}{" "}
          is not installed yet; install it before you start your first task.
        </p>
      )}
      {piInPlay && (
        <p
          data-testid="onboarding-pi-extension"
          className="text-xs text-muted-foreground"
        >
          Pi gets Harbormaster's small inbox extension installed automatically,
          so messages reach its sessions.
        </p>
      )}
      <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
        <Toggle
          checked={bypass}
          onChange={onBypass}
          testId="onboarding-bypass"
          label="Launched tasks run with permissions bypassed"
        />
        <div className="text-sm">
          <p className="font-medium">
            Launched tasks run with permissions bypassed
          </p>
          <p className="text-muted-foreground">
            Tasks run in disposable worktrees and you review every change before
            it merges; panes you open keep your own settings.
          </p>
        </div>
      </div>
    </div>
  );
}

// --- Screen 3: GitHub --------------------------------------------------------

function GithubStep({
  status,
  enabled,
  onEnabled,
  onRecheck,
}: {
  status: GithubAuthStatus | null;
  enabled: boolean;
  onEnabled(enabled: boolean): void;
  onRecheck(): void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <StepHeader title={ONBOARDING_STEPS[2].label}>
        Harbormaster uses the GitHub CLI (gh) you are already signed in to.
      </StepHeader>
      {!status ? (
        <p
          data-testid="onboarding-gh-checking"
          className="text-sm text-muted-foreground"
        >
          Checking gh auth status…
        </p>
      ) : status.authenticated ? (
        <p
          data-testid="onboarding-gh-account"
          className="flex items-center gap-2 text-sm"
        >
          <CheckCircle2 className="h-4 w-4 text-status-ok" />
          Signed in to {status.host ?? "GitHub"}
          {status.account ? (
            <>
              {" "}
              as <span className="font-medium">{status.account}</span>
            </>
          ) : null}
        </p>
      ) : (
        <div
          data-testid="onboarding-gh-login"
          className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm"
        >
          <p>
            {status.installed
              ? "gh is not signed in."
              : "The GitHub CLI (gh) is not installed."}{" "}
            {status.installed ? (
              <>
                Run <code className="rounded bg-muted px-1">gh auth login</code>{" "}
                in a terminal, then check again.
              </>
            ) : (
              <>
                Install it (
                <code className="rounded bg-muted px-1">brew install gh</code>
                ), run{" "}
                <code className="rounded bg-muted px-1">gh auth login</code>,
                then check again.
              </>
            )}
          </p>
          <p className="text-muted-foreground">
            You can also continue with GitHub off and turn it on later.
          </p>
          <div>
            <Button
              size="sm"
              variant="secondary"
              data-testid="onboarding-gh-recheck"
              onClick={onRecheck}
            >
              Check again
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
        <Toggle
          checked={enabled}
          onChange={onEnabled}
          disabled={!status?.authenticated}
          testId="onboarding-github-enabled"
          label="Enable GitHub"
        />
        <div className="text-sm">
          <p className="font-medium">Enable GitHub</p>
          <p className="text-muted-foreground">
            Moves your cards when your PRs get reviewed, merged and deployed,
            and turns review requests on other people's PRs into review tasks.
          </p>
        </div>
      </div>
    </div>
  );
}

// --- Screen 4: concepts ------------------------------------------------------

function Concept({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <div className="text-xs leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

function ConceptsStep(): JSX.Element {
  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-concepts">
      <StepHeader title={ONBOARDING_STEPS[3].label}>
        Four things to know before your first task.
      </StepHeader>
      <div className="flex flex-col gap-3.5">
        <Concept
          icon={<Columns3 className="h-4 w-4" />}
          title="Three columns, three verbs"
        >
          Dev, Awaiting, Done: move a task <em>to Dev</em>, <em>to Awaiting</em>{" "}
          or <em>Done</em>. Every task is a worktree, a branch, an agent session
          and a pane.
        </Concept>
        <Concept
          icon={<Scale className="h-4 w-4" />}
          title="Rules move cards for you"
        >
          They live in{" "}
          <code className="text-foreground">
            ~/.harbormaster/rules/rules.yaml
          </code>
          . Ask your agent to add a rule, e.g.
          <code className="mt-1 block whitespace-pre-wrap break-words rounded bg-muted px-1.5 py-1 text-[11px] text-foreground">
            {
              "- { id: merged-done, on: github.pr.mergedChanged, do: [{ action: move, with: { to: done } }] }"
            }
          </code>
        </Concept>
        <Concept icon={<Inbox className="h-4 w-4" />} title="The inbox">
          Everything that needs you lands in the inbox, split into Priority and
          Other. Open it with {modKeyLabel()}I.
        </Concept>
        <Concept
          icon={<MessagesSquare className="h-4 w-4" />}
          title="Tasks talk to each other"
        >
          An agent can launch child tasks and message them. A message to an
          unrelated task waits for your approval in the inbox.
        </Concept>
      </div>
      <p
        data-testid="onboarding-reopen-hint"
        className="text-xs text-muted-foreground"
      >
        You can reopen this from the Harbormaster menu (Welcome / Setup…).
      </p>
    </div>
  );
}

// --- The wizard ------------------------------------------------------------------

export function Onboarding({
  closable,
  onFinish,
  onClose,
}: OnboardingProps): JSX.Element {
  const api = window.harbormaster.onboarding;
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState<OnboardingState | null>(null);
  const wizardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Screen 1.
  const [root, setRoot] = useState("");
  const [scan, setScan] = useState<CodeRootScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [extras, setExtras] = useState<ExtraFolder[]>([]);
  const extrasRef = useRef(extras);
  extrasRef.current = extras;
  const [preselect, setPreselect] = useState("");
  const scanSeq = useRef(0);

  // Screen 2.
  const [detected, setDetected] = useState<DetectedAgent[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [choice, setChoice] = useState<AgentChoice>("pi");
  const choiceTouched = useRef(false);
  const [bypass, setBypass] = useState(true);

  // Screen 3.
  const [gh, setGh] = useState<GithubAuthStatus | null>(null);
  const [githubEnabled, setGithubEnabled] = useState(true);
  const githubTouched = useRef(false);

  const runScan = useCallback(
    (path: string) => {
      const seq = ++scanSeq.current;
      if (!path.trim()) {
        setScan(null);
        setScanning(false);
        return;
      }
      setScanning(true);
      api
        .scanCodeRoot(path)
        .then((result) => {
          if (seq !== scanSeq.current) return;
          setScan(result);
          // Keep a pick that is still listed (or an added folder);
          // otherwise preselect the new root's first repository.
          setPreselect((current) =>
            result.repositories.some((repo) => `repo:${repo.id}` === current) ||
            extrasRef.current.some(
              (folder) =>
                current === `folder:${folder.path}` ||
                current === `repo:${folder.repositoryId}`,
            )
              ? current
              : result.repositories[0]
                ? `repo:${result.repositories[0].id}`
                : "",
          );
        })
        .catch((cause: unknown) => {
          if (seq === scanSeq.current) setError(errorText(cause));
        })
        .finally(() => {
          if (seq === scanSeq.current) setScanning(false);
        });
    },
    [api],
  );

  const checkGithub = useCallback(() => {
    setGh(null);
    api
      .githubAuthStatus()
      .then((status) => {
        setGh(status);
        if (!githubTouched.current) setGithubEnabled(status.authenticated);
      })
      .catch((cause: unknown) =>
        setGh({
          installed: false,
          authenticated: false,
          error: errorText(cause),
        }),
      );
  }, [api]);

  const detectSeq = useRef(0);
  const detectAgents = useCallback(
    (configured: string) => {
      const seq = ++detectSeq.current;
      setDetecting(true);
      api
        .detectAgents()
        .then((agents) => {
          if (seq !== detectSeq.current) return;
          setDetected(agents);
          if (!choiceTouched.current) {
            setChoice(initialAgentChoice(configured, agents));
          }
        })
        .catch((cause: unknown) => {
          if (seq === detectSeq.current) setError(errorText(cause));
        })
        .finally(() => {
          if (seq === detectSeq.current) setDetecting(false);
        });
    },
    [api],
  );

  // Load the starting state, then kick off every probe in the background.
  useEffect(() => {
    let cancelled = false;
    void api.getState().then((loaded) => {
      if (cancelled) return;
      setState(loaded);
      setRoot(loaded.codeRoot);
      runScan(loaded.codeRoot);
      setBypass(loaded.bypassPermissions);
      // A stale custom default (no longer in config.json) falls back to Pi.
      const configured =
        isBuiltinAgent(loaded.defaultHarness) ||
        loaded.customAgents.some((agent) => agent.id === loaded.defaultHarness)
          ? loaded.defaultHarness
          : "pi";
      setChoice(initialAgentChoice(configured, []));
      detectAgents(configured);
    });
    checkGithub();
    return () => {
      cancelled = true;
    };
  }, [api, runScan, checkGithub, detectAgents]);

  // Rescan as the root is typed (debounced).
  const scanTimer = useRef<number | undefined>(undefined);
  const changeRoot = (next: string): void => {
    setRoot(next);
    setError("");
    window.clearTimeout(scanTimer.current);
    scanTimer.current = window.setTimeout(() => {
      scanTimer.current = undefined;
      runScan(next);
    }, 250);
  };
  useEffect(() => () => window.clearTimeout(scanTimer.current), []);

  const switchToSuggestedRoot = async (): Promise<void> => {
    if (!scan) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api.setCodeRoot(scan.suggestedRoot, { create: true });
      setRoot(saved.root);
      setScan(saved);
      setPreselect(
        saved.repositories[0] ? `repo:${saved.repositories[0].id}` : "",
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const addFolder = async (): Promise<void> => {
    const picked = await window.harbormaster.app.pickFolder();
    if (!picked) return;
    try {
      const location = await window.harbormaster.core.addLocation(picked);
      setExtras((current) =>
        current.some((entry) => entry.path === location.path)
          ? current
          : [...current, location],
      );
      setPreselect(
        location.repositoryId
          ? `repo:${location.repositoryId}`
          : `folder:${location.path}`,
      );
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  /** Save the current screen through core (rejects with the reason it could not). */
  const saveStep = async (): Promise<void> => {
    setError("");
    if (step === 0) {
      const saved = await api.setCodeRoot(root);
      setScan(saved);
      return;
    }
    if (step === 1) {
      setState(
        await api.setDefaultAgent({
          harness: choice,
          bypassPermissions: bypass,
        }),
      );
      return;
    }
    if (step === 2) {
      await api.setSourceEnabled("github", githubEnabled);
      await api.ensureDefaultRules();
      return;
    }
  };

  const next = async (): Promise<void> => {
    if (busy || !state) return;
    setBusy(true);
    try {
      await saveStep();
      if (step < STEP_COUNT - 1) {
        setStep(step + 1);
        return;
      }
      await api.complete();
      onFinish(preselect ? { where: preselect } : {});
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const goTo = (index: number): void => {
    if (busy || index < 0 || index >= step) return;
    setError("");
    setStep(index);
  };

  // Keyboard: one window-level listener (capture, so it sees keys even
  // when focus fell to <body>) reading the latest render through a ref.
  const keys = useRef({
    next,
    goTo,
    onClose,
    step,
    closable,
    scanning: false,
    flushScan: () => {},
  });
  keys.current = {
    next,
    goTo,
    onClose,
    step,
    closable,
    scanning,
    flushScan: () => {
      window.clearTimeout(scanTimer.current);
      scanTimer.current = undefined;
      runScan(root);
    },
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target =
        event.target instanceof HTMLElement ? event.target : undefined;
      const inside = !!target && !!wizardRef.current?.contains(target);
      const current = keys.current;
      const action = wizardKeyAction(
        event,
        {
          tag: inside && target ? target.tagName : "",
          type: target instanceof HTMLInputElement ? target.type : undefined,
          role: target?.getAttribute("role"),
          contentEditable: target?.isContentEditable,
          isPathInput: target?.dataset.pathInput === "true",
        },
        {
          step: current.step,
          closable: current.closable,
          scanSettled: !current.scanning && scanTimer.current === undefined,
        },
      );
      if (action !== "none") {
        event.preventDefault();
        event.stopPropagation();
        if (action === "primary") void current.next();
        else if (action === "back") current.goTo(current.step - 1);
        else if (action === "close") current.onClose();
        else if (action === "flush-scan") current.flushScan();
        return;
      }
      // The wizard is modal over a running app: no key reaches the app's
      // own window shortcuts (stopping propagation keeps default actions
      // like typing, Space on a switch or arrows in a radio group).
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Focus the first meaningful control of each step.
  const loaded = state !== null;
  const githubToggleTarget = (): HTMLElement | null =>
    contentRef.current?.querySelector<HTMLElement>(
      '[data-testid="onboarding-github-enabled"]:not(:disabled)',
    ) ?? primaryRef.current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves on step entry only.
  useEffect(() => {
    if (!loaded) return;
    const content = contentRef.current;
    let target: HTMLElement | null | undefined;
    if (step === 0) {
      target = content?.querySelector<HTMLElement>(
        '[data-testid="onboarding-code-root"]',
      );
    } else if (step === 1) {
      target =
        content?.querySelector<HTMLElement>(
          'input[name="onboarding-agent"]:checked',
        ) ??
        content?.querySelector<HTMLElement>('input[name="onboarding-agent"]');
    } else if (step === 2) {
      target = githubToggleTarget();
    } else {
      target = primaryRef.current;
    }
    target?.focus();
  }, [step, loaded]);
  // The gh status arrives later and enables the toggle: move focus there
  // unless the user already put it somewhere in the step.
  const ghReady = gh !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the status lands, not on every step change.
  useEffect(() => {
    if (step !== 2 || !ghReady) return;
    const active = document.activeElement;
    if (active && contentRef.current?.contains(active)) return;
    githubToggleTarget()?.focus();
  }, [ghReady]);

  const last = step === STEP_COUNT - 1;
  return (
    <div
      ref={wizardRef}
      data-testid="onboarding"
      data-step={ONBOARDING_STEPS[step]?.id}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background p-6 text-foreground"
    >
      <div
        data-testid="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="relative flex h-[38rem] max-h-full w-full max-w-[720px] overflow-hidden rounded-lg border border-border bg-card"
      >
        <nav
          aria-label="Setup steps"
          className="flex w-[200px] shrink-0 flex-col gap-6 border-r border-border bg-background/40 px-3 py-5"
        >
          <div className="flex items-center gap-2 px-2">
            <LogoGlyph className="h-5 w-5 shrink-0" />
            <span className="text-sm font-semibold leading-tight">
              Welcome to Harbormaster
            </span>
          </div>
          <Stepper step={step} disabled={busy} onGo={goTo} />
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={contentRef}
            className="min-h-0 flex-1 overflow-y-auto px-7 pb-4 pt-6"
          >
            {!state ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : step === 0 ? (
              <CodeStep
                state={state}
                root={root}
                onRootChange={changeRoot}
                scan={scan}
                scanning={scanning}
                extras={extras}
                onAddFolder={() => void addFolder()}
                preselect={preselect}
                onPreselect={setPreselect}
                onUseSuggested={() => void switchToSuggestedRoot()}
              />
            ) : step === 1 ? (
              <AgentStep
                state={state}
                detected={detected}
                detecting={detecting}
                onRescan={() => detectAgents(choice)}
                choice={choice}
                onChoice={(value) => {
                  choiceTouched.current = true;
                  setChoice(value);
                  setError("");
                }}
                bypass={bypass}
                onBypass={setBypass}
              />
            ) : step === 2 ? (
              <GithubStep
                status={gh}
                enabled={githubEnabled}
                onEnabled={(value) => {
                  githubTouched.current = true;
                  setGithubEnabled(value);
                }}
                onRecheck={checkGithub}
              />
            ) : (
              <ConceptsStep />
            )}
            {error && (
              <p
                data-testid="onboarding-error"
                className="mt-4 text-sm text-status-error"
              >
                {error}
              </p>
            )}
          </div>
          <footer
            data-testid="onboarding-footer"
            className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-3"
          >
            {step > 0 && (
              <Button
                variant="ghost"
                data-testid="onboarding-back"
                disabled={busy}
                title="Back (Esc)"
                onClick={() => goTo(step - 1)}
              >
                Back
              </Button>
            )}
            <Button
              ref={primaryRef}
              className="ml-auto"
              data-testid={last ? "onboarding-start" : "onboarding-next"}
              disabled={busy || !state}
              title={`${last ? "Start Harbormaster" : "Next"} (Enter)`}
              onClick={() => void next()}
            >
              {last ? "Start Harbormaster" : "Next"}
              <Kbd>↵</Kbd>
            </Button>
          </footer>
        </div>
        {closable && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-2 top-2 w-7 p-0"
            data-testid="onboarding-close"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
