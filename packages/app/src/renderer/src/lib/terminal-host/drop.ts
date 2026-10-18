/**
 * Drag-and-drop file integration for terminal panes (checklist item #3).
 *
 * When files are dragged onto the terminal container, their absolute paths
 * are shell-escaped and pasted into the terminal (cmux/Tabby/VS Code parity).
 * A document-level guard prevents unhandled file drops from navigating the
 * renderer to file:// URLs (item #0.7).
 */

import {
  shellEscapePath,
  shellEscapePaths,
} from "../../../../shared/shell-escape";
import type { HostContext, IDisposable } from "./context";

/**
 * Pure function: given resolved paths and a URI-list fallback, return the
 * string to paste, or null if there's nothing useful.
 *
 * Exported for unit testing.
 */
export function dropInsertText(
  paths: string[],
  uriList: string | null,
): string | null {
  if (paths.length > 0) return shellEscapePaths(paths);

  if (uriList) {
    const firstLine = uriList
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    if (firstLine) return shellEscapePath(firstLine);
  }

  return null;
}

/**
 * Install drag-over + drop handlers on `ctx.container`.
 * Also installs a document-level dragover/drop guard to prevent navigation.
 */
export function installDrop(ctx: HostContext): IDisposable {
  // Container: accept files.
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types);
    if (types.includes("Files") || types.includes("text/uri-list")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes("Files") && !types.includes("text/uri-list")) return;

    e.preventDefault();
    e.stopPropagation();

    const paths: string[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.harbormaster.terminalHost.getPathForFile(file);
      if (p) paths.push(p);
    }

    const uriList = types.includes("text/uri-list")
      ? (e.dataTransfer.getData("text/uri-list") ?? null)
      : null;

    const text = dropInsertText(paths, uriList);
    if (text) ctx.terminal.paste(text);
    ctx.terminal.focus();
  };

  ctx.container.addEventListener("dragover", onDragOver, true);
  ctx.container.addEventListener("drop", onDrop, true);

  // Document-level guard: prevent Chromium from navigating on unhandled drops.
  const docDragOver = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types);
    if (types.includes("Files")) {
      e.preventDefault();
    }
  };
  const docDrop = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types);
    if (types.includes("Files")) {
      e.preventDefault();
    }
  };

  document.addEventListener("dragover", docDragOver);
  document.addEventListener("drop", docDrop);

  return {
    dispose() {
      ctx.container.removeEventListener("dragover", onDragOver, true);
      ctx.container.removeEventListener("drop", onDrop, true);
      document.removeEventListener("dragover", docDragOver);
      document.removeEventListener("drop", docDrop);
    },
  };
}
