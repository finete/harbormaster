import { ChevronDown, Download } from "lucide-react";
import type { JSX } from "react";
import { openImportDialog } from "../lib/import-dialog";
import { modKeyLabel } from "../lib/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Kbd } from "./ui/kbd";
import {
  SplitButton,
  SplitButtonMain,
  SplitButtonTrigger,
} from "./ui/split-button";

/** The board header's "+ New task" with its menu: Import… brings in existing work (docs/import.md I4). */
export function NewTaskMenu({
  onNewTask,
}: {
  onNewTask: () => void;
}): JSX.Element {
  return (
    <SplitButton variant="default" size="sm">
      <SplitButtonMain data-testid="board-new-task-button" onClick={onNewTask}>
        + New task
        <Kbd>{`${modKeyLabel()}N`}</Kbd>
      </SplitButtonMain>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SplitButtonTrigger
            aria-label="More ways to add tasks"
            title="More ways to add tasks"
            data-testid="board-new-menu-trigger"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </SplitButtonTrigger>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="board-new-menu">
          <DropdownMenuItem
            data-testid="board-new-import"
            title="Bring in sessions from Claude Code, Codex, Pi, Cursor and herdr"
            onSelect={openImportDialog}
          >
            <Download />
            Import…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SplitButton>
  );
}
