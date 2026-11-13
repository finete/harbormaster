import type { IDockviewHeaderActionsProps } from "dockview-react";
import { SquareSplitHorizontal, SquareSplitVertical } from "lucide-react";
import type { JSX } from "react";
import { Button } from "./ui/button";

/**
 * Per-group right-corner header actions (split buttons): split
 * right opens a new shell panel as a new group to the right of this one,
 * split down does the same below. Each group gets its own instance (one
 * per `DockviewGroupPanel`), so `props.group`/`props.api` always refer to
 * the group this header belongs to — not the dockview-wide active group.
 */
export function makeGroupHeaderActions(
  onSplit: (groupId: string, direction: "right" | "below") => void,
): (props: IDockviewHeaderActionsProps) => JSX.Element {
  return function GroupHeaderActions(
    props: IDockviewHeaderActionsProps,
  ): JSX.Element {
    const groupId = props.group.id;
    return (
      <div className="flex items-center gap-0.5 px-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground"
          onClick={() => onSplit(groupId, "right")}
          data-testid="split-right-button"
          aria-label="Split right"
          title="Split right"
        >
          <SquareSplitHorizontal className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground"
          onClick={() => onSplit(groupId, "below")}
          data-testid="split-down-button"
          aria-label="Split down"
          title="Split down"
        >
          <SquareSplitVertical className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  };
}
