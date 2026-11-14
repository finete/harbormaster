// The Rules page's top-bar Edit split button (docs/rules-page.md decision
// #9), in the style of OpenInButton: the main part repeats the last-used
// choice (first time: Edit in chat), the chevron opens the menu. "Edit in
// chat" (first item) opens the New task composer prefilled to work in the rules folder
// (the user reviews and launches it; the folder's managed AGENTS.md /
// CLAUDE.md give the agent the rules language); the open-in apps, grouped
// like OpenInButton's, open the folder itself; "Copy path" copies it.

import { Check, ChevronDown, Copy, MessageSquare } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import { defaultOpenInApp, groupOpenInApps } from "../lib/open-in";
import {
  type RulesEditChoice,
  readRulesEditChoice,
  rulesEditRequest,
  writeRulesEditChoice,
} from "../lib/rules-format";
import {
  copyPath,
  openPathIn,
  useLastOpenInAppId,
  useOpenInApps,
} from "../lib/use-open-in";
import { OpenInKindIcon } from "./OpenInButton";
import { NO_RULES_FOLDER_TITLE } from "./RulesList";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  SplitButton,
  SplitButtonMain,
  SplitButtonTrigger,
} from "./ui/split-button";

export function RulesEditButton({
  folder,
  onEditInChat,
}: {
  /** The rules folder; undefined disables the button. */
  folder: string | undefined;
  /** Open the New task composer with this prefill. */
  onEditInChat: (request: ReturnType<typeof rulesEditRequest>) => void;
}): JSX.Element {
  const apps = useOpenInApps();
  const lastAppId = useLastOpenInAppId();
  const app = defaultOpenInApp(apps, lastAppId);
  const groups = groupOpenInApps(apps);
  const [stored, setStored] = useState<RulesEditChoice>(() =>
    readRulesEditChoice(window.localStorage),
  );
  // "app" with no app on this host falls back to chat.
  const choice: RulesEditChoice = stored === "app" && app ? "app" : "chat";

  const remember = (next: RulesEditChoice): void => {
    writeRulesEditChoice(window.localStorage, next);
    setStored(next);
  };
  const editInChat = (): void => {
    if (!folder) return;
    remember("chat");
    onEditInChat(rulesEditRequest(folder));
  };

  return (
    <SplitButton
      variant="secondary"
      size="sm"
      data-testid="rules-edit"
      title={folder ? undefined : NO_RULES_FOLDER_TITLE}
    >
      <SplitButtonMain
        disabled={!folder}
        data-testid="rules-open-folder"
        data-choice={choice}
        title={
          folder
            ? choice === "app" && app
              ? `Open the rules folder in ${app.label}`
              : "Ask an agent to edit the rules (opens the New task composer)"
            : NO_RULES_FOLDER_TITLE
        }
        onClick={() => {
          if (!folder) return;
          if (choice === "app" && app) void openPathIn(folder, app);
          else editInChat();
        }}
      >
        {choice === "app" && app ? (
          <>
            <OpenInKindIcon kind={app.kind} />
            {`Edit in ${app.label}`}
          </>
        ) : (
          <>
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            Edit in chat
          </>
        )}
      </SplitButtonMain>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!folder}>
          <SplitButtonTrigger
            aria-label="Edit with…"
            title={folder ? "Edit with…" : NO_RULES_FOLDER_TITLE}
            data-testid="rules-edit-menu-trigger"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </SplitButtonTrigger>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[13rem]"
          data-testid="rules-edit-menu"
        >
          <DropdownMenuGroup>
            <DropdownMenuItem
              data-testid="rules-edit-chat"
              title="Opens the New task composer in the rules folder, prefilled"
              onSelect={editInChat}
            >
              <MessageSquare />
              <span className="flex-1">Edit in chat</span>
              {choice === "chat" && (
                <Check className="h-3.5 w-3.5" aria-label="default" />
              )}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {groups.map((group) => (
            <DropdownMenuGroup key={group.kind}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
              {group.apps.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  data-testid={`rules-edit-app-${entry.id}`}
                  onSelect={() => {
                    if (!folder) return;
                    remember("app");
                    void openPathIn(folder, entry);
                  }}
                >
                  <OpenInKindIcon kind={entry.kind} />
                  <span className="flex-1">{entry.label}</span>
                  {choice === "app" && entry.id === app?.id && (
                    <Check className="h-3.5 w-3.5" aria-label="default" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="rules-edit-copy-path"
            onSelect={() => {
              if (folder) copyPath(folder);
            }}
          >
            <Copy />
            <span className="flex-1">Copy path</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SplitButton>
  );
}
