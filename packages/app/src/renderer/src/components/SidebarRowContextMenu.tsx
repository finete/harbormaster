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
  /**
   * Nested items shown in a flyout to the right (hover, click, or
   * ArrowRight/Enter); this item's own `onSelect` is not called.
   */
  submenu?: ContextMenuItem[];
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
  // The open flyout (key of its parent item) and the active row inside it
  // (-1 while it was opened by hover, so arrows start from the top).
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [subIndex, setSubIndex] = useState(-1);
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

  function select(item: ContextMenuItem): void {
    if (item.disabled) return;
    if (item.submenu) {
      setOpenSubmenu(item.key);
      setSubIndex(item.submenu.findIndex((sub) => !sub.disabled));
      return;
    }
    item.onSelect();
    onClose();
  }

  function onSubmenuKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    submenu: ContextMenuItem[],
  ): boolean {
    const enabled = submenu
      .map((item, index) => (item.disabled ? -1 : index))
      .filter((index) => index !== -1);
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      setOpenSubmenu(null);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (enabled.length === 0) return true;
      const pos = enabled.indexOf(subIndex);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        pos === -1 ? 0 : (pos + delta + enabled.length) % enabled.length;
      setSubIndex(enabled[next] ?? -1);
      return true;
    }
    if (event.key === "Enter" || event.key === " ") {
      const item = submenu[subIndex];
      if (item) select(item);
      return true;
    }
    return false;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const flyout = items.find((item) => item.key === openSubmenu)?.submenu;
    if (flyout && onSubmenuKeyDown(event, flyout)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item?.submenu) select(item);
      return;
    }
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
      if (item) select(item);
    }
  }

  // Clamp so the menu never renders off the right/bottom edge of the window.
  const style = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 28 - 16),
  };

  // Flyouts open to the left when there is no room on the right.
  const flyoutLeft = style.left + 200 + 170 > window.innerWidth;

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
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground outline-none"
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
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? openSubmenu === item.key : undefined}
            onMouseEnter={() => {
              if (item.disabled) return;
              setActiveIndex(index);
              if (item.submenu) {
                setOpenSubmenu(item.key);
                setSubIndex(-1);
              } else setOpenSubmenu(null);
            }}
            onClick={() => select(item)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                select(item);
              }
            }}
            className={cn(
              // 14px text on a 16px line keeps every item 28px tall: the clamp
              // below and the flyout placement assume that height.
              "relative flex cursor-pointer items-center rounded px-2 py-1.5 text-sm leading-4 transition-colors duration-[120ms] ease-out",
              item.disabled && "cursor-default opacity-40",
              !item.disabled && activeIndex === index && "bg-accent",
              item.danger && !item.disabled && "text-status-error",
            )}
          >
            <span className="flex-1">{item.label}</span>
            {item.submenu && <span aria-hidden>›</span>}
            {item.submenu && openSubmenu === item.key && (
              <div
                role="menu"
                data-testid={`${testId}-submenu-${item.key}`}
                className={cn(
                  "absolute top-0 min-w-[160px] rounded-lg border border-border bg-popover p-1",
                  flyoutLeft ? "right-full mr-1" : "left-full ml-1",
                )}
              >
                {item.submenu.map((sub, subPos) => (
                  <div key={sub.key}>
                    {sub.separatorBefore && (
                      <div className="my-1 h-px bg-border" aria-hidden />
                    )}
                    <div
                      role="menuitem"
                      tabIndex={-1}
                      aria-disabled={sub.disabled || undefined}
                      data-testid={`${testId}-item-${sub.key}`}
                      onMouseEnter={() => !sub.disabled && setSubIndex(subPos)}
                      onClick={(event) => {
                        event.stopPropagation();
                        select(sub);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          select(sub);
                        }
                      }}
                      className={cn(
                        "cursor-pointer rounded px-2 py-1.5 text-sm leading-4 text-foreground transition-colors duration-[120ms] ease-out",
                        sub.disabled && "cursor-default opacity-40",
                        !sub.disabled && subIndex === subPos && "bg-accent",
                      )}
                    >
                      {sub.label}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
