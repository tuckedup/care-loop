import { describe, expect, it } from "vitest";
import { anchorId, noteSourceId } from "./view-model";

describe("noteSourceId / anchorId", () => {
  it("is prefixed, element-id safe, never an evt-N id, and keeps different raw ids distinct", () => {
    const raws = ["n1", "evt-5", 'a b"<x>', "a_b", "a b", "note-1", "1", " x", "x".repeat(500)];
    const ids = raws.map(noteSourceId);
    for (const id of ids) {
      expect(id).toMatch(/^note-[A-Za-z0-9_-]+$/);
      expect(id).not.toMatch(/^evt-[0-9]+$/);
      expect(id.length).toBeLessThanOrEqual(100);
      expect(anchorId(id)).toBe(`src-${id}`);
    }
    expect(new Set(ids).size).toBe(raws.length);
    expect(noteSourceId("evt-5")).toBe("note-evt-5");
  });
});
