// Hiding the sidebar entirely (Cmd/Ctrl+B or its hide button), the way
// macOS apps hide theirs. App owns the hidden state; while hidden, every
// main-area header shows a small "Show sidebar" button at its leading edge
// (the toolbar toggle of Finder, Notes, Mail), read from this context so the
// headers need no new props.
import { PanelLeftOpen } from "lucide-react";
import { createContext, type JSX, useContext } from "react";
import { sidebarShortcutLabel } from "../lib/platform";
import { cn } from "../lib/utils";

/** Shows the sidebar again; `null` while it is visible. */
export const SidebarRevealContext = createContext<(() => void) | null>(null);

const HIDDEN_KEY = "harbormaster.sidebar.hidden";

export function readSidebarHidden(storage: Storage): boolean {
  try {
    return storage.getItem(HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeSidebarHidden(storage: Storage, hidden: boolean): void {
  try {
    storage.setItem(HIDDEN_KEY, String(hidden));
  } catch {
    // Storage unavailable: the sidebar just won't stay hidden next launch.
  }
}

/** The leading "Show sidebar" button; renders nothing while it's visible. */
export function SidebarRevealButton({
  className,
}: {
  className?: string;
}): JSX.Element | null {
  const show = useContext(SidebarRevealContext);
  if (!show) return null;
  const label = `Show sidebar (${sidebarShortcutLabel()})`;
  return (
    <button
      type="button"
      data-testid="sidebar-reveal"
      aria-label="Show sidebar"
      title={label}
      onClick={show}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] ease-out hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <PanelLeftOpen className="h-4 w-4" aria-hidden />
    </button>
  );
}
