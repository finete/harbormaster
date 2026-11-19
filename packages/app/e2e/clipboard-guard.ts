// Global setup/teardown (playwright.config.ts): notes macOS's pasteboard
// change counter before the run and warns after it if the counter moved.
// Every launch uses the app's private test clipboard
// (main/app-clipboard.ts), so a moved counter means the developer copied
// something during the run, or a spec reached the real clipboard through a
// native path (tests/clipboard-isolation.test.ts covers the code paths).
import { execFileSync } from "node:child_process";

function changeCount(): number | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return Number(
      execFileSync(
        "osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount',
        ],
        { encoding: "utf8", timeout: 5_000 },
      ).trim(),
    );
  } catch {
    return undefined;
  }
}

export default function setup(): () => void {
  const before = changeCount();
  return () => {
    const after = changeCount();
    if (before !== undefined && after !== undefined && after !== before) {
      console.warn(
        `[clipboard] the system clipboard changed ${after - before} time(s) during this e2e run: either you copied something, or a spec reached the real clipboard (specs must use e2e/test-clipboard.ts).`,
      );
    }
  };
}
