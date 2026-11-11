import { describe, expect, it } from "vitest";
import {
  ProgramStatusParser,
  parseProgramStatusBody,
  programStatusProbeReply,
} from "../src/utilities/program-status.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const b64 = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64");

describe("ProgramStatusParser", () => {
  it("strips a BEL-terminated report and surfaces its state", () => {
    const parser = new ProgramStatusParser();
    const result = parser.feed(`before${ESC}]7501;state=working${BEL}after`);
    expect(result.output).toBe("beforeafter");
    expect(result.reports).toEqual([{ state: "working" }]);
    expect(result.replies).toEqual([]);
  });

  it("decodes msg, kind and app on an ST-terminated blocked report", () => {
    const parser = new ProgramStatusParser();
    const raw = `${ESC}]7501;state=blocked:kind=question:app=pi:msg=${b64("Pick a branch")}${ST}`;
    expect(parser.feed(raw)).toEqual({
      output: "",
      reports: [
        {
          state: "blocked",
          kind: "question",
          app: "pi",
          message: "Pick a branch",
        },
      ],
      replies: [],
    });
  });

  it("answers the probe with the same terminator and removes it from the output", () => {
    const parser = new ProgramStatusParser();
    expect(parser.feed(`a${ESC}]7501;?${BEL}b`)).toEqual({
      output: "ab",
      reports: [],
      replies: [`${ESC}]7501;?${BEL}`],
    });
    expect(parser.feed(`${ESC}]7501;?${ST}`).replies).toEqual([
      programStatusProbeReply(ST),
    ]);
  });

  it("reassembles a report split across chunks at every byte", () => {
    const raw = `x${ESC}]7501;state=done:msg=${b64("Shipped")}${ST}y`;
    for (let split = 1; split < raw.length; split++) {
      const parser = new ProgramStatusParser();
      const first = parser.feed(raw.slice(0, split));
      const second = parser.feed(raw.slice(split));
      expect(first.output + second.output).toBe("xy");
      expect([...first.reports, ...second.reports]).toEqual([
        { state: "done", message: "Shipped" },
      ]);
    }
  });

  it("reassembles a probe split between ESC and backslash", () => {
    const parser = new ProgramStatusParser();
    const first = parser.feed(`${ESC}]7501;?${ESC}`);
    expect(first).toEqual({ output: "", reports: [], replies: [] });
    expect(parser.feed("\\rest").replies).toEqual([`${ESC}]7501;?${ST}`]);
  });

  it("passes other escape sequences through untouched, including other OSCs", () => {
    const parser = new ProgramStatusParser();
    const other = `${ESC}]0;title${BEL}${ESC}[31mred${ESC}]750;x${BEL}`;
    expect(parser.feed(other).output).toBe(other);
  });

  it("handles several reports in one chunk, in order", () => {
    const parser = new ProgramStatusParser();
    const result = parser.feed(
      `${ESC}]7501;state=working${BEL}mid${ESC}]7501;state=idle${ST}`,
    );
    expect(result.output).toBe("mid");
    expect(result.reports.map((r) => r.state)).toEqual(["working", "idle"]);
  });

  it("consumes but ignores unknown states, child ids and bad base64", () => {
    const parser = new ProgramStatusParser();
    const result = parser.feed(
      [
        `${ESC}]7501;state=sleeping${BEL}`,
        `${ESC}]7501;state=working:id=build/test${BEL}`,
        `${ESC}]7501;state=done:msg=QQ=Q${BEL}`,
        `${ESC}]7501;state=done:msg=${b64("two\nlines")}${BEL}`,
      ].join(""),
    );
    expect(result.output).toBe("");
    expect(result.reports).toEqual([]);
  });

  it("maps a root clear to idle", () => {
    expect(parseProgramStatusBody("state=clear")).toEqual({ state: "idle" });
  });

  it("aborts on an ESC that is not ST and passes the bytes through", () => {
    const parser = new ProgramStatusParser();
    const raw = `${ESC}]7501;state=working${ESC}[0m`;
    const result = parser.feed(raw);
    expect(result.output).toBe(raw);
    expect(result.reports).toEqual([]);
  });

  it("gives up holding a sequence past the 4096-byte cap", () => {
    const parser = new ProgramStatusParser();
    const huge = `${ESC}]7501;state=working:msg=${"A".repeat(5000)}`;
    const result = parser.feed(huge);
    expect(result.output).toBe(huge);
    expect(parser.flush()).toBe("");
  });

  it("holds back only a trailing introducer prefix, and flush releases it", () => {
    const parser = new ProgramStatusParser();
    expect(parser.feed(`text${ESC}]75`).output).toBe("text");
    expect(parser.flush()).toBe(`${ESC}]75`);
    expect(parser.feed(`${ESC}]7`).output).toBe("");
    expect(parser.feed("0;x").output).toBe(`${ESC}]70;x`);
  });
});
