// Platform-aware modifier-key label for kbd hints/tooltips (Board button,
// New task, Start/Await/Done chips, ...). Takes the platform string as a
// parameter (defaulting to `navigator.platform`) so it's unit-testable
// without a DOM/Electron environment.
export function isMacPlatform(platform: string = navigator.platform): boolean {
  return /mac/i.test(platform);
}

/** "⌘" on macOS, "Ctrl+" everywhere else — matches native menu conventions. */
export function modKeyLabel(platform: string = navigator.platform): string {
  return isMacPlatform(platform) ? "⌘" : "Ctrl+";
}
