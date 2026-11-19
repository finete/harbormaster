// The app's private e2e clipboard (main/app-clipboard.ts, on for every
// launch via playwright.config.ts): specs seed and read it here, never
// Electron's `clipboard` (that is the developer's real clipboard). Each
// call throws if the launch has no test clipboard, so a spec can never
// fall back to the real one.
import type { ElectronApplication } from "@playwright/test";

const MISSING =
  "no test clipboard in main: launch with HARBORMASTER_E2E_FAKE_CLIPBOARD=1 (playwright.config.ts sets it)";

export async function clearTestClipboard(
  app: ElectronApplication,
): Promise<void> {
  await app.evaluate((_electron, missing) => {
    const clip = (
      globalThis as { __harbormasterTestClipboard?: { clear(): void } }
    ).__harbormasterTestClipboard;
    if (!clip) throw new Error(missing);
    clip.clear();
  }, MISSING);
}

export async function writeTestClipboardText(
  app: ElectronApplication,
  text: string,
): Promise<void> {
  await app.evaluate(
    (_electron, [value, missing]) => {
      const clip = (
        globalThis as {
          __harbormasterTestClipboard?: { writeText(t: string): void };
        }
      ).__harbormasterTestClipboard;
      if (!clip) throw new Error(missing);
      clip.writeText(value as string);
    },
    [text, MISSING],
  );
}

export async function readTestClipboardText(
  app: ElectronApplication,
): Promise<string> {
  return app.evaluate((_electron, missing) => {
    const clip = (
      globalThis as { __harbormasterTestClipboard?: { readText(): string } }
    ).__harbormasterTestClipboard;
    if (!clip) throw new Error(missing);
    return clip.readText();
  }, MISSING);
}

/** Replaces the clipboard with a PNG image (base64). */
export async function writeTestClipboardImage(
  app: ElectronApplication,
  pngBase64: string,
): Promise<void> {
  await app.evaluate(
    ({ nativeImage }, [base64, missing]) => {
      const clip = (
        globalThis as {
          __harbormasterTestClipboard?: { writeImage(image: unknown): void };
        }
      ).__harbormasterTestClipboard;
      if (!clip) throw new Error(missing);
      clip.writeImage(
        nativeImage.createFromBuffer(Buffer.from(base64 as string, "base64")),
      );
    },
    [pngBase64, MISSING],
  );
}

/** Adds one raw format (e.g. Finder's NSFilenamesPboardType plist). */
export async function writeTestClipboardBuffer(
  app: ElectronApplication,
  format: string,
  data: string,
): Promise<void> {
  await app.evaluate(
    (_electron, [name, value, missing]) => {
      const clip = (
        globalThis as {
          __harbormasterTestClipboard?: {
            writeBuffer(format: string, buffer: Buffer): void;
          };
        }
      ).__harbormasterTestClipboard;
      if (!clip) throw new Error(missing);
      clip.writeBuffer(name as string, Buffer.from(value as string, "utf8"));
    },
    [format, data, MISSING],
  );
}
