// The one clipboard the app uses: the system clipboard normally, a private
// in-memory one under e2e (HARBORMASTER_E2E_FAKE_CLIPBOARD=1, set for every
// launch by playwright.config.ts). Tests then never overwrite what the
// developer copied, the same way they never show a window. Every
// clipboard read or write in main goes through `appClipboard`; the renderer
// copies through `app:copyText` (never `navigator.clipboard`), and a
// terminal's Cmd+C is routed there too (TerminalPane). Specs seed and read
// the fake through `globalThis.__harbormasterTestClipboard` in main
// (`app.evaluate`).
import { clipboard, type NativeImage, nativeImage } from "electron";

/** The slice of Electron's `clipboard` the app uses. */
export interface AppClipboard {
  availableFormats(): string[];
  read(format: string): string;
  readText(): string;
  readImage(): NativeImage;
  writeText(text: string): void;
}

/** The e2e clipboard, plus the writes specs seed it with. */
export class MemoryClipboard implements AppClipboard {
  private text: string | undefined;
  private image: NativeImage | undefined;
  private readonly buffers = new Map<string, Buffer>();

  availableFormats(): string[] {
    return [
      ...(this.text !== undefined ? ["text/plain"] : []),
      ...(this.image && !this.image.isEmpty() ? ["image/png"] : []),
      ...this.buffers.keys(),
    ];
  }

  read(format: string): string {
    if (format === "text/plain") return this.text ?? "";
    return this.buffers.get(format)?.toString("utf8") ?? "";
  }

  readText(): string {
    return this.text ?? "";
  }

  readImage(): NativeImage {
    return this.image ?? nativeImage.createEmpty();
  }

  /** Like Electron's: replaces whatever was on the clipboard. */
  writeText(text: string): void {
    this.clear();
    this.text = text;
  }

  writeImage(image: NativeImage): void {
    this.clear();
    this.image = image;
  }

  /** Adds one raw format (Finder's file list, a file URL) alongside the rest. */
  writeBuffer(format: string, buffer: Buffer): void {
    this.buffers.set(format, buffer);
  }

  clear(): void {
    this.text = undefined;
    this.image = undefined;
    this.buffers.clear();
  }
}

const fake =
  process.env.HARBORMASTER_E2E_FAKE_CLIPBOARD === "1"
    ? new MemoryClipboard()
    : undefined;
if (fake) {
  (
    globalThis as { __harbormasterTestClipboard?: MemoryClipboard }
  ).__harbormasterTestClipboard = fake;
}

export const appClipboard: AppClipboard = fake ?? clipboard;
