import type { JSX } from "react";
import { useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Label } from "./ui/label";

/**
 * Reopening a Done task starts a new Dev cycle (fresh branch + worktree, the
 * previous conversation forked into its next pi pane). pi-home asks "What
 * should Pi do now?" before reopening (presentation/flows.ts
 * `chooseFreshObjective`); this is that one optional question — pi-home's
 * rename and plan-mode prompts are deliberately not carried over. An empty
 * objective just opens the forked session for the user to type into.
 */
export function ReopenTaskDialog({
  open,
  title,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: (objective: string) => void;
}): JSX.Element {
  const [objective, setObjective] = useState("");

  function handleCancel(): void {
    setObjective("");
    onCancel();
  }

  function handleConfirm(): void {
    const value = objective.trim();
    setObjective("");
    onConfirm(value);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleCancel();
      }}
      title={`Reopen “${title}”`}
      testId="reopen-task-dialog"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="reopen-task-objective">
          What should Pi do now?
          <span className="ml-1 font-normal text-muted-foreground">
            (optional)
          </span>
        </Label>
        <textarea
          id="reopen-task-objective"
          data-testid="reopen-task-objective-input"
          rows={4}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              handleConfirm();
            }
          }}
          placeholder="Sent as the first message of the reopened session, which continues the previous conversation."
          className="min-h-[84px] w-full resize-y rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors duration-[120ms] ease-out placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCancel}
          data-testid="reopen-task-cancel"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleConfirm}
          data-testid="reopen-task-confirm"
        >
          Reopen
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
