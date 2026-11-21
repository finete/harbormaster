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
  /** The cancel button's label ("Cancel" when omitted). */
  cancelLabel?: string;
  /** An opt-in checkbox under the body, unchecked each time the dialog opens (e.g. Done's "Also stop these N tasks"). */
  option?: ConfirmOption;
  resolve: (confirmed: boolean, optionChecked?: boolean) => void;
}

/** A checkbox on a confirm question, with a warning line shown beside it. */
export interface ConfirmOption {
  label: string;
  /** Muted warning under the checkbox (what ticking it costs). */
  warning: string;
  /** Test id of the checkbox input. */
  testId: string;
}

type Listener = (request: ConfirmRequest | undefined) => void;

let queue: ConfirmRequest[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(queue[0]);
}

interface ConfirmQuestion {
  title: string;
  message: string;
  lines?: string[];
  enterConfirms?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

function enqueue(
  question: ConfirmQuestion,
  option: ConfirmOption | undefined,
  done: (confirmed: boolean, optionChecked: boolean) => void,
): void {
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
      ...(question.cancelLabel ? { cancelLabel: question.cancelLabel } : {}),
      ...(option ? { option } : {}),
      resolve: (confirmed, optionChecked = false) => {
        queue = queue.filter((request) => request.id !== id);
        emit();
        done(confirmed, confirmed && optionChecked);
      },
    },
  ];
  emit();
}

/** Ask a yes/no question; resolves `true` only on an explicit confirm. */
export function requestConfirm(question: ConfirmQuestion): Promise<boolean> {
  return new Promise((resolve) => {
    enqueue(question, undefined, (confirmed) => resolve(confirmed));
  });
}

/**
 * A yes/no question with one opt-in checkbox (unchecked every time the
 * dialog opens). `checked` is only ever true alongside `confirmed`.
 */
export function requestConfirmWithOption(
  question: ConfirmQuestion,
  option: ConfirmOption,
): Promise<{ confirmed: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    enqueue(question, option, (confirmed, checked) =>
      resolve({ confirmed, checked }),
    );
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
