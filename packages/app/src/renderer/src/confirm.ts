// Minimal confirm bus, the dialog counterpart of toast.ts: any mutation
// (Done from a button, a key, or a drop) can ask the user a yes/no question
// and await the answer without prop-drilling dialog state through the tree.
// `ConfirmHost` is the single renderer of the pending question.

export interface ConfirmRequest {
  id: string;
  title: string;
  message: string;
  /** Extra body lines, one paragraph each (e.g. Done's "what will happen" list). */
  lines?: string[];
  /** Enter confirms: the confirm button takes focus on open (Done's "Mark done"). */
  enterConfirms?: boolean;
  confirmLabel: string;
  resolve: (confirmed: boolean) => void;
}

type Listener = (request: ConfirmRequest | undefined) => void;

let queue: ConfirmRequest[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(queue[0]);
}

/** Ask a yes/no question; resolves `true` only on an explicit confirm. */
export function requestConfirm(question: {
  title: string;
  message: string;
  lines?: string[];
  enterConfirms?: boolean;
  confirmLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    queue = [
      ...queue,
      {
        id,
        title: question.title,
        message: question.message,
        ...(question.lines?.length ? { lines: question.lines } : {}),
        ...(question.enterConfirms ? { enterConfirms: true } : {}),
        confirmLabel: question.confirmLabel ?? "Confirm",
        resolve: (confirmed) => {
          queue = queue.filter((request) => request.id !== id);
          emit();
          resolve(confirmed);
        },
      },
    ];
    emit();
  });
}

/** Whether a question is on screen (single-key shortcuts stay quiet meanwhile). */
export function isConfirmOpen(): boolean {
  return queue.length > 0;
}

export function subscribeConfirm(listener: Listener): () => void {
  listeners.add(listener);
  listener(queue[0]);
  return () => listeners.delete(listener);
}
