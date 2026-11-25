// The Import… dialog's open state: a tiny module-level bus (like confirm.ts)
// so the "+ New" menu and Settings → General open the one dialog the app
// shell hosts, without threading a prop through both.

type Listener = (open: boolean) => void;

let isOpen = false;
const listeners = new Set<Listener>();

export function openImportDialog(): void {
  setOpen(true);
}

export function closeImportDialog(): void {
  setOpen(false);
}

function setOpen(next: boolean): void {
  if (isOpen === next) return;
  isOpen = next;
  for (const listener of listeners) listener(next);
}

export function subscribeImportDialog(listener: Listener): () => void {
  listeners.add(listener);
  listener(isOpen);
  return () => {
    listeners.delete(listener);
  };
}
