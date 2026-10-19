// Minimal toast bus: no library (see /AGENTS.md UI stack), just a
// module-level pub/sub so any component (TaskActions deep inside a card or
// workspace header, App's refresh-warning subscription, ...) can surface a
// dismissible message without prop-drilling a callback through the whole
// tree. `ToastHost` is the single renderer of whatever is currently queued
// (capped: see `capVisibleToasts`).
//
// Hygiene, independent of the connectivity banner (see ConnectivityBanner.tsx
// for the environmental-state side of things): a long run of distinct
// per-tick warning strings must never grow into an undismissable wall —
// identical bodies dedupe, warnings expire on their own, and the visible
// stack is capped with a "+N more" row instead of growing unbounded.
import { isConnectivityError } from "./lib/connectivity-classifier";

export interface ToastMessage {
  id: string;
  text: string;
  tone: "error" | "warning" | "success";
}

type Listener = (toasts: ToastMessage[]) => void;

/** Warnings auto-dismiss on their own; errors need a deliberate click (user action may still be needed). */
export const WARNING_AUTO_DISMISS_MS = 20_000;

/** How many toasts `ToastHost` renders before collapsing the rest into a "+N more" row. */
export const TOAST_VISIBLE_CAP = 4;

let toasts: ToastMessage[] = [];
const listeners = new Set<Listener>();
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

/** Pure: true when an identical, still-visible body would make this push a no-op duplicate. */
export function isDuplicateToast(
  existing: readonly ToastMessage[],
  text: string,
): boolean {
  return existing.some((toast) => toast.text === text);
}

/**
 * Pure: splits a toast list into what `ToastHost` renders directly and how
 * many more are collapsed behind the "+N more" row. The newest toasts stay
 * visible (unshifted onto the front elsewhere), so the cap always hides the
 * *oldest* overflow, not the newest arrival.
 */
export function capVisibleToasts(
  all: readonly ToastMessage[],
  cap: number = TOAST_VISIBLE_CAP,
): { visible: ToastMessage[]; overflow: ToastMessage[] } {
  if (all.length <= cap) return { visible: [...all], overflow: [] };
  return { visible: all.slice(0, cap), overflow: all.slice(cap) };
}

export function pushToast(
  text: string,
  tone: ToastMessage["tone"] = "error",
): void {
  // Defense-in-depth: a connectivity-shaped message must never reach the
  // toast stack even if some future call site forgets to route it through
  // the connectivity banner instead (see engines/connectivity.ts — the real
  // guard is core's refresh() never putting these in `warnings` at all).
  if (isConnectivityError(text)) return;
  if (isDuplicateToast(toasts, text)) return;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  toasts = [{ id, text, tone }, ...toasts];
  emit();

  if (tone === "warning" || tone === "success") {
    const timer = setTimeout(() => dismissToast(id), WARNING_AUTO_DISMISS_MS);
    autoDismissTimers.set(id, timer);
  }
}

export function dismissToast(id: string): void {
  const timer = autoDismissTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoDismissTimers.delete(id);
  }
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}

/** Renders a thrown error (or any unknown value) into toast-ready text. */
export function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
