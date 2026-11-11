// The first-run wizard (docs/release-plan.md "Onboarding (four screens)",
// R14): code root + repositories, default agent, GitHub, concepts. A
// full-window view shown before the normal UI on first run, and over it
// from the "Welcome / Setup…" menu item. Every read and write is a core
// command through `window.harbormaster.onboarding` (main forwards; the
// renderer never touches the filesystem or a CLI). Probes resolve
// asynchronously with timeouts in core, so nothing here blocks on them.

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Columns3,
  FolderOpen,
  GitBranch,
  Inbox,
  MessagesSquare,
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
  type AgentChoice,
  type CustomAgentForm,
  customAgentFormProblem,
  customAgentFromForm,
  emptyCustomAgentForm,
  initialAgentChoice,
  suggestAgentId,
} from "../lib/onboarding";
import { modKeyLabel } from "../lib/platform";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const STEPS = ["Code", "Agent", "GitHub", "Concepts"] as const;

/** What "Start" hands back: the Where the first task's composer preselects. */
export interface OnboardingResult {
  /** A composer Where token (`repo:<id>` / `folder:<path>`), when one was picked. */
  where?: string;
}

interface OnboardingProps {
  /** Shown from the menu over a running app: offers a close button. */
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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-foreground transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function Radio({
  name,
  checked,
  onSelect,
  testId,
  children,
  disabled,
  extra,
}: {
  name: string;
  checked: boolean;
  onSelect(): void;
  testId: string;
  children: ReactNode;
  disabled?: boolean;
  extra?: Record<string, string>;
}): JSX.Element {
  return (
    <label
      data-testid={testId}
      data-checked={checked}
      {...extra}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
        checked
          ? "border-primary bg-primary/10"
          : "border-border hover:bg-accent",
        disabled && "cursor-default opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="h-4 w-4 shrink-0 accent-sky-500"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
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
  error,
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
  error: string;
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
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Where is your code?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Harbormaster finds every git repository directly under this folder.
          Each task gets its own worktree inside it.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-code-root">Code folder</Label>
        <div className="flex gap-2">
          <Input
            id="onboarding-code-root"
            data-testid="onboarding-code-root"
            value={root}
            spellCheck={false}
            onChange={(event) => onRootChange(event.target.value)}
          />
          <Button
            variant="outline"
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
          className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="flex-1">
            <p>
              macOS ties folder permissions to this unsigned build; you may be
              asked again after each upgrade. A plain folder like ~/Code never
              asks.
            </p>
            <Button
              size="sm"
              variant="outline"
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
          <Label>Repositories found</Label>
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
            data-testid="onboarding-repo-list"
            className="flex max-h-56 flex-col gap-1 overflow-y-auto"
          >
            {rows.map((row) => (
              <Radio
                key={row.key}
                name="onboarding-repo"
                checked={preselect === row.key}
                onSelect={() => onPreselect(row.key)}
                testId="onboarding-repo"
                extra={{ "data-where": row.key }}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-medium">{row.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {row.detail}
                  </span>
                </span>
              </Radio>
            ))}
          </div>
        )}
        {rows.length > 0 && (
          <p className="text-xs text-muted-foreground">
            The selected one is preselected for your first task.
          </p>
        )}
      </div>
      <div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="onboarding-add-folder"
          onClick={onAddFolder}
        >
          Add another folder…
        </Button>
      </div>
      {error && (
        <p data-testid="onboarding-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
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

// --- Screen 2: default agent -------------------------------------------------

function AgentStep({
  detected,
  choice,
  onChoice,
  form,
  onForm,
  bypass,
  onBypass,
  error,
}: {
  detected: DetectedAgent[] | null;
  choice: AgentChoice;
  onChoice(choice: AgentChoice): void;
  form: CustomAgentForm;
  onForm(form: CustomAgentForm): void;
  bypass: boolean;
  onBypass(bypass: boolean): void;
  error: string;
}): JSX.Element {
  const agent = (id: string) => detected?.find((entry) => entry.id === id);
  const status = (id: string): ReactNode => {
    if (!detected) return "Detecting…";
    const found = agent(id);
    if (!found) return "";
    return found.available ? (
      <span className="text-emerald-400">
        {found.version ? `v${found.version}` : "installed"}
      </span>
    ) : (
      <span title={`${found.command}: ${found.error ?? "not found"}`}>
        {found.error ?? "not found"}
      </span>
    );
  };
  const piInPlay = choice === "pi" || agent("pi")?.available;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Which agent runs your tasks?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          New tasks start on this agent. You can pick another per repository or
          per task.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {(
          [
            ["pi", "Pi"],
            ["claude-code", "Claude Code"],
          ] as const
        ).map(([id, label]) => (
          <Radio
            key={id}
            name="onboarding-agent"
            checked={choice === id}
            onSelect={() => onChoice(id)}
            testId={`onboarding-agent-${id}`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium">{label}</span>
              <span
                data-testid={`onboarding-agent-${id}-status`}
                className="text-xs text-muted-foreground"
              >
                {status(id)}
              </span>
            </span>
          </Radio>
        ))}
        <Radio
          name="onboarding-agent"
          checked={choice === "custom"}
          onSelect={() => onChoice("custom")}
          testId="onboarding-agent-custom"
        >
          <span className="font-medium">Other CLI</span>
        </Radio>
      </div>
      {choice === "custom" && (
        <div
          data-testid="onboarding-custom-form"
          className="grid grid-cols-[6rem_1fr] items-center gap-2 rounded-md border border-border p-3"
        >
          <Label htmlFor="onboarding-custom-label">Name</Label>
          <Input
            id="onboarding-custom-label"
            data-testid="onboarding-custom-label"
            value={form.label}
            placeholder="Aider"
            onChange={(event) => onForm({ ...form, label: event.target.value })}
          />
          <Label htmlFor="onboarding-custom-command">Command</Label>
          <Input
            id="onboarding-custom-command"
            data-testid="onboarding-custom-command"
            value={form.command}
            spellCheck={false}
            placeholder="aider"
            onChange={(event) =>
              onForm({ ...form, command: event.target.value })
            }
          />
          <Label htmlFor="onboarding-custom-args">Arguments</Label>
          <Input
            id="onboarding-custom-args"
            data-testid="onboarding-custom-args"
            value={form.args}
            spellCheck={false}
            placeholder="--yes-always"
            onChange={(event) => onForm({ ...form, args: event.target.value })}
          />
          <span />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="onboarding-custom-positional"
              checked={form.promptPositional}
              onChange={(event) =>
                onForm({ ...form, promptPositional: event.target.checked })
              }
            />
            Pass the task prompt as the last argument
          </label>
          {form.label.trim() && (
            <>
              <span />
              <span className="text-xs text-muted-foreground">
                Saved as agent id <code>{suggestAgentId(form.label)}</code>
              </span>
            </>
          )}
        </div>
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
      <div className="flex items-start gap-3 rounded-md border border-border p-3">
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
            Background tasks work in disposable worktrees, and you still review
            every change before it merges. Panes you open keep your own
            settings.
          </p>
        </div>
      </div>
      {error && (
        <p data-testid="onboarding-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

// --- Screen 3: GitHub --------------------------------------------------------

function GithubStep({
  status,
  enabled,
  onEnabled,
  onRecheck,
  error,
}: {
  status: GithubAuthStatus | null;
  enabled: boolean;
  onEnabled(enabled: boolean): void;
  onRecheck(): void;
  error: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Connect GitHub</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Harbormaster uses the GitHub CLI (gh) you are already signed in to.
        </p>
      </div>
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
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
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
          className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
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
              variant="outline"
              data-testid="onboarding-gh-recheck"
              onClick={onRecheck}
            >
              Check again
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-start gap-3 rounded-md border border-border p-3">
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
      {error && (
        <p data-testid="onboarding-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

// --- Screen 4: concepts ------------------------------------------------------

function ConceptCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
      <p className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </p>
      <div className="text-xs leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function ConceptsStep(): JSX.Element {
  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-concepts">
      <div className="flex flex-col items-center gap-2 text-center">
        <LogoGlyph className="h-14 w-14 text-foreground" />
        <h2 className="text-lg font-semibold">How Harbormaster works</h2>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ConceptCard
          icon={<Columns3 className="h-4 w-4" />}
          title="Three columns, three verbs"
        >
          Dev, Awaiting, Done: move a task <em>to Dev</em>, <em>to Awaiting</em>{" "}
          or <em>Done</em>. Every task is a worktree, a branch, an agent session
          and a pane.
        </ConceptCard>
        <ConceptCard
          icon={<Scale className="h-4 w-4" />}
          title="Rules move cards for you"
        >
          They live in{" "}
          <code className="text-foreground">
            ~/.harbormaster/rules/rules.yaml
          </code>
          . Ask your agent to add a rule, e.g.
          <code className="mt-1 block overflow-x-auto whitespace-nowrap rounded bg-muted px-1.5 py-1 text-[11px] text-foreground">
            {
              "- { id: merged-done, on: github.pr.mergedChanged, do: [{ action: move, with: { to: done } }] }"
            }
          </code>
        </ConceptCard>
        <ConceptCard icon={<Inbox className="h-4 w-4" />} title="The inbox">
          Everything that needs you lands in the inbox, split into Priority and
          Other. Open it with {modKeyLabel()}I.
        </ConceptCard>
        <ConceptCard
          icon={<MessagesSquare className="h-4 w-4" />}
          title="Tasks talk to each other"
        >
          An agent can launch child tasks and message them. A message to an
          unrelated task waits for your approval in the inbox.
        </ConceptCard>
      </div>
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
  const [choice, setChoice] = useState<AgentChoice>("pi");
  const choiceTouched = useRef(false);
  const [form, setForm] = useState<CustomAgentForm>(emptyCustomAgentForm);
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

  // Load the starting state, then kick off every probe in the background.
  useEffect(() => {
    let cancelled = false;
    void api.getState().then((loaded) => {
      if (cancelled) return;
      setState(loaded);
      setRoot(loaded.codeRoot);
      runScan(loaded.codeRoot);
      setBypass(loaded.bypassPermissions);
      const custom = loaded.customAgents.find(
        (agent) => agent.id === loaded.defaultHarness,
      );
      if (custom) {
        setForm({
          label: custom.label,
          command: custom.command,
          args: (custom.args ?? []).join(" "),
          promptPositional: custom.promptArg !== "none",
        });
      }
      setChoice(initialAgentChoice(loaded.defaultHarness, []));
      void api.detectAgents().then((agents) => {
        if (cancelled) return;
        setDetected(agents);
        if (!choiceTouched.current) {
          setChoice(initialAgentChoice(loaded.defaultHarness, agents));
        }
      });
    });
    checkGithub();
    return () => {
      cancelled = true;
    };
  }, [api, runScan, checkGithub]);

  // Rescan as the root is typed (debounced).
  const scanTimer = useRef<number | undefined>(undefined);
  const changeRoot = (next: string): void => {
    setRoot(next);
    setError("");
    window.clearTimeout(scanTimer.current);
    scanTimer.current = window.setTimeout(() => runScan(next), 250);
  };

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
      if (choice === "custom") {
        const problem = customAgentFormProblem(form);
        if (problem) throw new Error(problem);
        const customAgent = customAgentFromForm(form);
        setState(
          await api.setDefaultAgent({
            harness: customAgent.id,
            customAgent,
            bypassPermissions: bypass,
          }),
        );
      } else {
        setState(
          await api.setDefaultAgent({
            harness: choice,
            bypassPermissions: bypass,
          }),
        );
      }
      return;
    }
    if (step === 2) {
      await api.setSourceEnabled("github", githubEnabled);
      await api.ensureDefaultRules();
      return;
    }
  };

  const next = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await saveStep();
      if (step < STEPS.length - 1) {
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

  const last = step === STEPS.length - 1;
  return (
    <div
      data-testid="onboarding"
      data-step={STEPS[step]?.toLowerCase()}
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <LogoGlyph className="h-5 w-5" />
        <span className="text-sm font-semibold">Welcome to Harbormaster</span>
        <ol className="ml-4 flex items-center gap-1 text-xs text-muted-foreground">
          {STEPS.map((label, index) => (
            <li key={label} className="flex items-center gap-1">
              {index > 0 && <ArrowRight className="h-3 w-3" />}
              <span
                className={cn(
                  index === step && "font-semibold text-foreground",
                  index < step && "text-foreground/80",
                )}
              >
                {index + 1}. {label}
              </span>
            </li>
          ))}
        </ol>
        {closable && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 w-7 p-0"
            data-testid="onboarding-close"
            title="Close"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-6 py-8">
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
              error={error}
            />
          ) : step === 1 ? (
            <AgentStep
              detected={detected}
              choice={choice}
              onChoice={(value) => {
                choiceTouched.current = true;
                setChoice(value);
                setError("");
              }}
              form={form}
              onForm={setForm}
              bypass={bypass}
              onBypass={setBypass}
              error={error}
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
              error={error}
            />
          ) : (
            <>
              <ConceptsStep />
              {error && (
                <p
                  data-testid="onboarding-error"
                  className="mt-3 text-sm text-red-400"
                >
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      </main>
      <footer className="flex h-14 shrink-0 items-center justify-between border-t border-border px-4">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" />
          Step {step + 1} of {STEPS.length}
        </span>
        <div className="flex gap-2">
          {step > 0 && (
            <Button
              variant="outline"
              data-testid="onboarding-back"
              disabled={busy}
              onClick={() => {
                setError("");
                setStep(step - 1);
              }}
            >
              Back
            </Button>
          )}
          <Button
            data-testid={last ? "onboarding-start" : "onboarding-next"}
            disabled={busy || !state}
            onClick={() => void next()}
          >
            {last ? "Start" : "Next"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
