// Lightweight, dependency-free right-click context menu for sidebar rows
// (Orca polish item 6). No menu library (see AGENTS.md UI stack: no
// surprise dependencies for a thing seven `<button>`s can do) — a fixed-
// position panel, arrow-key navigable, closes on Escape or an outside
// click/blur. Matches the app's existing popover styling (border/bg/shadow
// tokens lifted from ui/dialog.tsx).
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

export interface ContextMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Visually separate this item from the one above it (e.g. before a destructive action). */
  separatorBefore?: boolean;
  danger?: boolean;
}

export function SidebarRowContextMenu({
  x,
  y,
  items,
  onClose,
  testId,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  testId: string;
}): JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const enabledIndexes = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index !== -1);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [onClose]);

  function move(delta: 1 | -1): void {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const nextPos =
      (current === -1 ? 0 : current + delta + enabledIndexes.length) %
      enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPos] ?? 0);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item && !item.disabled) {
        item.onSelect();
        onClose();
      }
    }
  }

  // Clamp so the menu never renders off the right/bottom edge of the window.
  const style = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 28 - 16),
  };

  return (
    <div
      ref={containerRef}
      role="menu"
      tabIndex={-1}
      data-testid={testId}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget as Node))
          onClose();
      }}
      style={style}
      className="fixed z-50 min-w-[180px] rounded-md border border-border bg-background p-1 text-sm text-foreground shadow-lg outline-none"
    >
      {items.map((item, index) => (
        <div key={item.key}>
          {item.separatorBefore && (
            <div className="my-1 h-px bg-border" aria-hidden />
          )}
          <div
            role="menuitem"
            tabIndex={-1}
            aria-disabled={item.disabled || undefined}
            data-testid={`${testId}-item-${item.key}`}
            onMouseEnter={() => !item.disabled && setActiveIndex(index)}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
            onKeyDown={(event) => {
              if (
                (event.key === "Enter" || event.key === " ") &&
                !item.disabled
              ) {
                event.preventDefault();
                item.onSelect();
                onClose();
              }
            }}
            className={cn(
              "cursor-pointer rounded px-2 py-1.5 text-xs transition-colors",
              item.disabled && "cursor-default opacity-40",
              !item.disabled && activeIndex === index && "bg-accent/70",
              item.danger && !item.disabled && "text-red-400",
            )}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}
