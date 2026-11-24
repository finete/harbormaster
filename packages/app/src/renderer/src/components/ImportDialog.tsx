import type { JSX } from "react";
import { useEffect, useState } from "react";
import { closeImportDialog, subscribeImportDialog } from "../lib/import-dialog";
import { importButtonLabel } from "../lib/import-list";
import { useImportList } from "../lib/use-import-list";
import { describeThrown, pushToast } from "../toast";
import { ImportList } from "./ImportList";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";

/** Hosts the Import… dialog (opened from "+ New" and Settings → General). */
export function ImportDialogHost(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeImportDialog(setOpen), []);
  if (!open) return null;
  return <ImportDialog />;
}

/** A fresh listing on every open; closes after an import (the inbox item is the summary). */
function ImportDialog(): JSX.Element {
  const model = useImportList();

  async function runImport(): Promise<void> {
    if (model.count === 0 || model.importing) return;
    try {
      const result = await model.importSelected();
      if (!result) return;
      if (result.imported.length === 0) {
        // Nothing came in (state moved since the listing): stay open on a fresh list.
        pushToast("Nothing could be imported", "error");
        model.refresh();
        return;
      }
      closeImportDialog();
    } catch (thrown) {
      pushToast(describeThrown(thrown), "error");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeImportDialog();
      }}
      title="Import existing work"
      testId="import-dialog"
      className="flex max-h-[80vh] w-[760px] max-w-[92vw] flex-col"
    >
      <p className="mb-2 text-sm text-muted-foreground">
        Sessions from your agents and herdr become tasks, opened in place.
        Nothing is copied or changed until you open a task.
      </p>
      <ImportList
        model={model}
        onSubmit={() => void runImport()}
        className="min-h-0 flex-1"
      />
      <DialogFooter>
        <Button
          variant="secondary"
          data-testid="import-cancel"
          onClick={closeImportDialog}
        >
          Cancel
        </Button>
        <Button
          data-testid="import-submit"
          disabled={model.count === 0 || model.importing}
          onClick={() => void runImport()}
        >
          {importButtonLabel(model.count)}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
