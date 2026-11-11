/**
 * Right-click context menu for terminal panes (checklist item #16).
 *
 * Items: Copy, Paste, Select All, Clear.
 */

import type { JSX } from "react";
import { clearTerminal } from "../lib/terminal-host/clear";
import type { HostContext } from "../lib/terminal-host/context";
import { pasteFromClipboard } from "../lib/terminal-host/paste";
import {
  type ContextMenuItem,
  SidebarRowContextMenu,
} from "./SidebarRowContextMenu";

export function TerminalContextMenu({
  x,
  y,
  ctx,
  onClose,
}: {
  x: number;
  y: number;
  ctx: HostContext;
  onClose: () => void;
}): JSX.Element {
  const { terminal } = ctx;
  const hasSelection = terminal.hasSelection();

  const items: ContextMenuItem[] = [
    {
      key: "copy",
      label: "Copy",
      disabled: !hasSelection,
      onSelect: () => {
        const sel = terminal.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
      },
    },
    {
      key: "paste",
      label: "Paste",
      onSelect: () => void pasteFromClipboard(ctx),
    },
    {
      key: "select-all",
      label: "Select All",
      onSelect: () => terminal.selectAll(),
    },
    {
      key: "clear",
      label: "Clear",
      separatorBefore: true,
      onSelect: () => clearTerminal(terminal),
    },
  ];

  return (
    <SidebarRowContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      testId="terminal-context-menu"
    />
  );
}
