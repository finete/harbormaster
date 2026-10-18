import { describe, expect, it } from "vitest";
import {
  type ClipboardPasteOptions,
  resolveClipboardPaste,
} from "../src/main/clipboard-paste";

/** Fake clipboard with full control over each format */
function makeClipboard(opts: {
  plistPaths?: string[];
  fileUrl?: string;
  text?: string;
  imageSize?: number; // bytes; 0 means isEmpty=true
}): ClipboardPasteOptions["clipboard"] {
  return {
    availableFormats() {
      const formats: string[] = [];
      if (opts.fileUrl) formats.push("public.file-url");
      return formats;
    },
    read(format: string) {
      if (format === "NSFilenamesPboardType" && opts.plistPaths) {
        return (
          "<plist>" +
          opts.plistPaths.map((p) => `<string>${p}</string>`).join("") +
          "</plist>"
        );
      }
      if (format === "public.file-url" && opts.fileUrl) return opts.fileUrl;
      if (format === "text/uri-list" && opts.fileUrl) return opts.fileUrl;
      return "";
    },
    readText() {
      return opts.text ?? "";
    },
    readImage() {
      const size = opts.imageSize ?? 0;
      return {
        isEmpty() {
          return size === 0;
        },
        toPNG() {
          return Buffer.alloc(size, 0x89); // PNG-ish bytes
        },
      };
    },
  };
}

function makeFs(existingPaths: string[]) {
  return {
    writeFileSync(path: string, _data: Buffer, _opts: { mode: number }) {
      existingPaths.push(path);
    },
    existsSync(p: string) {
      return existingPaths.includes(p);
    },
  };
}

const NOW = new Date("2026-01-02T03:04:05.000");
const UUID = () => "abcdef12-3456-7890-abcd-ef1234567890";
const TMPDIR = "/tmp/test";

function makeOpts(
  clipboard: ClipboardPasteOptions["clipboard"],
  fs: ClipboardPasteOptions["fs"],
): ClipboardPasteOptions {
  return { clipboard, fs, tmpdir: TMPDIR, now: NOW, uuid: UUID };
}

describe("resolveClipboardPaste", () => {
  it("returns null when clipboard is completely empty", () => {
    const clipboard = makeClipboard({});
    const fs = makeFs([]);
    expect(resolveClipboardPaste(makeOpts(clipboard, fs))).toBeNull();
  });

  it("returns plain text when only text is on the clipboard", () => {
    const clipboard = makeClipboard({ text: "hello world" });
    const fs = makeFs([]);
    expect(resolveClipboardPaste(makeOpts(clipboard, fs))).toBe("hello world");
  });

  it("returns null for an oversized image", () => {
    const clipboard = makeClipboard({ imageSize: 11 * 1024 * 1024 });
    const fs = makeFs([]);
    expect(resolveClipboardPaste(makeOpts(clipboard, fs))).toBeNull();
  });

  it("writes a PNG and returns its escaped path for an image", () => {
    const written: string[] = [];
    const clipboard = makeClipboard({ imageSize: 1024 });
    const fs = makeFs(written);
    const result = resolveClipboardPaste(makeOpts(clipboard, fs));
    // Date: 2026-01-02 03:04:05, UUID prefix: ABCDEF12 (first 8 hex of uuid).
    const expected = `${TMPDIR}/clipboard-2026-01-02-030405-ABCDEF12.png`;
    expect(result).toBe(expected);
    expect(written).toContain(expected);
  });

  it("escapes an image path that contains spaces", () => {
    const written: string[] = [];
    const tmpdir = "/tmp/my folder";
    const clipboard = makeClipboard({ imageSize: 100 });
    const fs = makeFs(written);
    const result = resolveClipboardPaste({
      clipboard,
      fs,
      tmpdir,
      now: NOW,
      uuid: UUID,
    });
    expect(result).toContain("\\ "); // space is escaped
  });

  it("file URL beats plain text (priority check)", () => {
    const existingFile = "/Users/test/doc.txt";
    const clipboard = makeClipboard({
      plistPaths: [existingFile],
      text: "doc.txt",
    });
    const fs = makeFs([existingFile]);
    const result = resolveClipboardPaste(makeOpts(clipboard, fs));
    // File path is returned, not the bare filename.
    expect(result).toContain("/Users/test/doc.txt");
    expect(result).not.toBe("doc.txt");
  });

  it("text beats image (priority check)", () => {
    const clipboard = makeClipboard({ text: "some text", imageSize: 512 });
    const fs = makeFs([]);
    const result = resolveClipboardPaste(makeOpts(clipboard, fs));
    expect(result).toBe("some text");
  });

  it("escapes file paths that contain spaces", () => {
    const existingFile = "/Users/test/my file.png";
    const clipboard = makeClipboard({ plistPaths: [existingFile] });
    const fs = makeFs([existingFile]);
    const result = resolveClipboardPaste(makeOpts(clipboard, fs));
    expect(result).toBe("/Users/test/my\\ file.png");
  });

  it("skips plist paths that do not exist on disk", () => {
    const clipboard = makeClipboard({
      plistPaths: ["/does/not/exist.txt"],
      text: "fallback",
    });
    const fs = makeFs([]);
    const result = resolveClipboardPaste(makeOpts(clipboard, fs));
    // Falls through to text.
    expect(result).toBe("fallback");
  });
});
