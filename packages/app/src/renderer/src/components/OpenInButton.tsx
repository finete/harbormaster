// "Open in …" split button (mirrors Plannotator's open-in picker): the main
// part opens the task's whole worktree folder in the last-used app; the
// chevron opens a menu of this host's apps grouped by kind (file manager,
// editors, terminals) with a check on the current default, plus "Copy path".
// Launching happens in main (main/open-in.ts), behind the same path
// allowlist as "Reveal in Finder"; this component only sends an app id.

import {
  Check,
  ChevronDown,
  Code2,
  Copy,
  FolderOpen,
  TerminalSquare,
} from "lucide-react";
import type { JSX } from "react";
import type { OpenInAppInfo } from "../../../preload/api";
import { defaultOpenInApp, groupOpenInApps } from "../lib/open-in";
import {
  copyPath,
  openPathIn,
  useLastOpenInAppId,
  useOpenInApps,
} from "../lib/use-open-in";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function OpenInKindIcon({
  kind,
  className,
}: {
  kind: OpenInAppInfo["kind"];
  className?: string;
}): JSX.Element {
  const Icon =
    kind === "file-manager"
      ? FolderOpen
      : kind === "editor"
        ? Code2
        : TerminalSquare;
  return <Icon className={cn("h-3.5 w-3.5", className)} aria-hidden />;
}

const NO_WORKTREE = "This task has no worktree yet";

export function OpenInButton({
  path,
  testId = "open-in",
}: {
  /** The task's worktree/workspace folder; undefined disables the button. */
  path: string | undefined;
  testId?: string;
}): JSX.Element {
  const apps = useOpenInApps();
  const lastId = useLastOpenInAppId();
  const current = defaultOpenInApp(apps, lastId);
  const disabled = !path || !current;
  const groups = groupOpenInApps(apps);

  return (
    <div
      className="inline-flex h-8 items-stretch rounded-md border border-border text-xs"
      data-testid={testId}
      title={path ? undefined : NO_WORKTREE}
    >
      <button
        type="button"
        disabled={disabled}
        data-testid={`${testId}-main`}
        data-app-id={current?.id}
        onClick={() => {
          if (path && current) void openPathIn(path, current);
        }}
        title={
          path
            ? current
              ? `Open ${path} in ${current.label}`
              : undefined
            : NO_WORKTREE
        }
        className="inline-flex items-center gap-1.5 rounded-l-md px-2 font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        {current && <OpenInKindIcon kind={current.kind} />}
        {current ? `Open in ${current.label}` : "Open in…"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!path || apps.length === 0}>
          <button
            type="button"
            aria-label="Open in…"
            title={path ? "Open in…" : NO_WORKTREE}
            data-testid={`${testId}-menu-trigger`}
            className="inline-flex items-center rounded-r-md border-l border-border px-1.5 transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[12rem]"
          data-testid={`${testId}-menu`}
        >
          {groups.map((group, index) => (
            <DropdownMenuGroup key={group.kind}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              {group.apps.map((app) => (
                <DropdownMenuItem
                  key={app.id}
                  data-testid={`${testId}-app-${app.id}`}
                  onSelect={() => {
                    if (path) void openPathIn(path, app);
                  }}
                >
                  <OpenInKindIcon kind={app.kind} />
                  <span className="flex-1">{app.label}</span>
                  {app.id === current?.id && (
                    <Check
                      className="h-3.5 w-3.5"
                      aria-label="default"
                      data-testid={`${testId}-default-check`}
                    />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid={`${testId}-copy-path`}
            onSelect={() => {
              if (path) copyPath(path);
            }}
          >
            <Copy />
            <span className="flex-1">Copy path</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
