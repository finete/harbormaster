// Pure rules behind the approval inbox cards (lib/approval-cards.ts).
import { describe, expect, it } from "vitest";
import type { MessageAttachment } from "../src/preload/api";
import {
  approvalEdits,
  attachmentDataUrl,
  attachmentName,
  canApprove,
  isThumbnailable,
} from "../src/renderer/src/lib/approval-cards";

const original = { text: "do the thing", requestedMode: "steer" as const };

describe("approvalEdits", () => {
  it("is undefined when nothing changed (Approve sends no edits)", () => {
    expect(
      approvalEdits(original, { text: "do the thing", mode: "steer" }),
    ).toBeUndefined();
  });

  it("sends only what changed", () => {
    expect(
      approvalEdits(original, { text: "do another thing", mode: "steer" }),
    ).toEqual({ text: "do another thing" });
    expect(
      approvalEdits(original, { text: "do the thing", mode: "followUp" }),
    ).toEqual({ mode: "followUp" });
    expect(approvalEdits(original, { text: "x", mode: "followUp" })).toEqual({
      text: "x",
      mode: "followUp",
    });
  });
});

describe("canApprove", () => {
  it("requires non-blank text", () => {
    expect(canApprove("hi")).toBe(true);
    expect(canApprove("  \n ")).toBe(false);
  });
});

function attachment(overrides: Partial<MessageAttachment>): MessageAttachment {
  return {
    path: "/state/messages/attachments/m/0-shot.png",
    originalPath: "/tmp/shots/shot.png",
    bytes: 10,
    ...overrides,
  };
}

describe("attachments", () => {
  it("thumbnails only existing images", () => {
    expect(isThumbnailable(attachment({ mimeType: "image/png" }))).toBe(true);
    expect(isThumbnailable(attachment({ mimeType: "text/plain" }))).toBe(false);
    expect(isThumbnailable(attachment({}))).toBe(false);
    expect(
      isThumbnailable(
        attachment({ mimeType: "image/png", prunedAt: "2026-01-01T00:00:00Z" }),
      ),
    ).toBe(false);
  });

  it("names an attachment by its original file name (either separator)", () => {
    expect(attachmentName(attachment({}))).toBe("shot.png");
    expect(
      attachmentName(attachment({ originalPath: "C:\\a\\b\\log.txt" })),
    ).toBe("log.txt");
  });

  it("builds a data URL, defaulting the mime type", () => {
    expect(attachmentDataUrl({ mimeType: "image/png", base64: "QUJD" })).toBe(
      "data:image/png;base64,QUJD",
    );
    expect(attachmentDataUrl({ base64: "QUJD" })).toBe(
      "data:application/octet-stream;base64,QUJD",
    );
  });
});
