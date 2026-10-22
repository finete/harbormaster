import { describe, expect, it } from "vitest";
import { LruMap } from "../src/utilities/lru-map.js";

describe("LruMap", () => {
  it("evicts the least recently used entry past capacity", () => {
    const map = new LruMap<string, number>(2);
    map.set("a", 1).set("b", 2);
    expect(map.get("a")).toBe(1); // "b" is now least recent
    map.set("c", 3);
    expect(map.size).toBe(2);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("a")).toBe(1);
    expect(map.get("c")).toBe(3);
  });

  it("keeps falsy values retrievable", () => {
    const map = new LruMap<string, boolean>(2);
    map.set("x", false);
    expect(map.get("x")).toBe(false);
  });
});
