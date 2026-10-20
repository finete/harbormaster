// Shared pointer-drag guards for the board (Board.tsx) and the sidebar
// (Sidebar.tsx), both dnd-kit PointerSensor users:
//
// - click-after-drag suppression: dnd-kit doesn't cancel the native `click`
//   the browser still fires on pointerup after a completed drag, so a real
//   drag must not also "select/open" the row it started on;
// - Escape-key guard: dnd-kit's PointerSensor cancels a drag on an Escape
//   keydown at the document, synchronously, before any window-level handler
//   sees the same event — that Escape must not then also run a second
//   Escape action (clear sidebar search, board "back to workspace", ...).
import { useCallback, useRef } from "react";

export interface DragGuards {
  /** True for the whole drag and the rest of the event dispatch that ended it. Escape/arrow handlers bail while set. */
  dragKeyGuardRef: { readonly current: boolean };
  /** Call from onDragStart. */
  beginDrag: () => void;
  /** Call from onDragEnd / onDragCancel. */
  endDrag: () => void;
  /** Wrap a click handler: returns true (and re-arms) when this click is the tail of a drag and must be ignored. */
  consumeDragClick: () => boolean;
}

export function useDragGuards(): DragGuards {
  const draggedRef = useRef(false);
  const dragKeyGuardRef = useRef(false);

  const beginDrag = useCallback((): void => {
    draggedRef.current = true;
    dragKeyGuardRef.current = true;
  }, []);

  // The suppressed click (if any) is dispatched right after pointerup, i.e.
  // before a 0ms timer fires; clear the flags then, so a drop that produced
  // no click can't swallow the next genuine click.
  const endDrag = useCallback((): void => {
    setTimeout(() => {
      draggedRef.current = false;
      dragKeyGuardRef.current = false;
    }, 0);
  }, []);

  const consumeDragClick = useCallback((): boolean => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return true;
    }
    return false;
  }, []);

  return { dragKeyGuardRef, beginDrag, endDrag, consumeDragClick };
}
