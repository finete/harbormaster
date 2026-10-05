// Minimal toast bus: no library (see /AGENTS.md UI stack), just a
// module-level pub/sub so any component (TaskActions deep inside a card or
// workspace header, App's refresh-warning subscription, ...) can surface a
// dismissible message without prop-drilling a callback through the whole
// tree. `ToastHost` is the single renderer of whatever is currently queued.

export interface ToastMessage {
  id: string;
  text: string;
  tone: "error" | "warning";
}

type Listener = (toasts: ToastMessage[]) => void;

let toasts: ToastMessage[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

export function pushToast(
  text: string,
  tone: ToastMessage["tone"] = "error",
): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  toasts = [...toasts, { id, text, tone }];
  emit();
}

export function dismissToast(id: string): void {
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
