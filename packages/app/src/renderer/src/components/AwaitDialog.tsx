import type { JSX, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type {
  AwaitingKindId,
  AwaitingKindOption,
  ToAwaitOptions,
} from "../../../preload/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** The kind preselected on open: Enter right away is the review fast path. */
const DEFAULT_KIND: AwaitingKindId = "review";

export interface AwaitChoice {
  kindId: AwaitingKindId;
  options: ToAwaitOptions;
}

/**
 * The unified "Await…" picker: the one entry point to the toawait verb,
 * shared by the workspace header's Await… button, the board's `r` key, and
 * a drop on the Awaiting column. The kinds (and, per task, whether each
 * applies and what entering it will do) come from core's awaiting-kind
 * registry (`listAwaitingKinds`) — nothing here knows what any kind does;
 * it only renders the registry's labels, inputs, and notices. Review is
 * preselected, so Enter right away confirms it. Cancel aborts with nothing
 * moved.
 */
export function AwaitDialog({
  taskId,
  onCancel,
  onConfirm,
}: {
  /** Open for this task; `null` = closed. */
  taskId: string | null;
  onCancel: () => void;
  onConfirm: (choice: AwaitChoice) => void;
}): JSX.Element {
  const [kinds, setKinds] = useState<AwaitingKindOption[] | null>(null);
  const [selected, setSelected] = useState<AwaitingKindId>(DEFAULT_KIND);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  // Dialog focuses the first focusable element on open: this wrapper
  // (tabIndex -1), so Enter confirms the preselected kind even before the
  // kinds have loaded — never the Cancel button.
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setKinds(null);
    setSelected(DEFAULT_KIND);
    setInputs({});
    if (!taskId) return;
    let cancelled = false;
    void window.harbormaster.core
      .listAwaitingKinds(taskId)
      .then((listed) => {
        if (cancelled) return;
        setKinds(listed);
        // Keep the user's pick if they already moved off the default while
        // loading; only fall back when the default doesn't apply.
        setSelected((current) => {
          const pick = listed.find((kind) => kind.id === current);
          if (pick?.available) return current;
          return listed.find((kind) => kind.available)?.id ?? current;
        });
      })
      .catch(() => {
        if (!cancelled) setKinds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Once the kinds render, hand focus to the selected radio (arrow keys
  // then switch kinds), unless the user already focused something else.
  useEffect(() => {
    if (!kinds || document.activeElement !== bodyRef.current) return;
    bodyRef.current
      ?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?.focus();
  }, [kinds]);

  const selectedKind = kinds?.find((kind) => kind.id === selected);
  // Before the registry answers, only the default (review) fast path may
  // confirm; core still validates and rejects with a toast if it can't.
  const canConfirm = selectedKind
    ? selectedKind.available
    : kinds === null && selected === DEFAULT_KIND;

  function handleConfirm(): void {
    if (!canConfirm) return;
    onConfirm({ kindId: selected, options: { inputs } });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    // A focused button handles Enter itself (Cancel must stay Cancel).
    if ((event.target as HTMLElement).tagName === "BUTTON") return;
    event.preventDefault();
    handleConfirm();
  }

  return (
    <Dialog
      open={taskId !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Why is this task awaiting?"
      testId="await-picker"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Enter-to-confirm boundary for the whole picker; the controls inside are the interactive elements. */}
      <div
        ref={bodyRef}
        tabIndex={-1}
        className="outline-none"
        onKeyDown={onKeyDown}
      >
        <fieldset
          className="flex flex-col gap-2"
          data-testid="await-picker-kinds"
          aria-busy={kinds === null}
        >
          {(kinds ?? []).map((kind) => (
            <label
              key={kind.id}
              className={cn(
                "flex items-start gap-2 text-sm",
                !kind.available && "opacity-50",
              )}
              title={kind.unavailableReason}
            >
              <input
                type="radio"
                name="await-kind"
                className="mt-1"
                value={kind.id}
                checked={selected === kind.id}
                disabled={!kind.available}
                onChange={() => setSelected(kind.id)}
                data-testid={`await-picker-kind-${kind.id}`}
              />
              <span className="flex flex-col">
                <span>{kind.label}</span>
                <span className="text-xs text-muted-foreground">
                  {kind.available
                    ? kind.description
                    : `Unavailable: ${kind.unavailableReason ?? "not for this task"}`}
                </span>
              </span>
            </label>
          ))}
          {kinds === null && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
        </fieldset>

        {selectedKind?.notice && (
          <p
            className="mt-3 rounded border border-border bg-muted/30 px-2 py-1.5 text-xs"
            data-testid="await-picker-notice"
          >
            {selectedKind.notice}
          </p>
        )}

        {selectedKind?.fields.map((field) => (
          <div key={field.id} className="mt-3 flex flex-col gap-1">
            <Label htmlFor={`await-field-${field.id}`}>
              {field.label}
              {field.optional ? " (optional)" : ""}
            </Label>
            <Input
              id={`await-field-${field.id}`}
              data-testid={`await-picker-field-${field.id}`}
              value={inputs[field.id] ?? ""}
              onChange={(event) =>
                setInputs((previous) => ({
                  ...previous,
                  [field.id]: event.target.value,
                }))
              }
              placeholder={field.placeholder}
            />
          </div>
        ))}
      </div>

      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          data-testid="await-picker-cancel"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canConfirm}
          onClick={handleConfirm}
          data-testid="await-picker-confirm"
        >
          Await
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
