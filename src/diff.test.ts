import { describe, it, expect } from "vitest";
import { computeDiff, type DiffLine } from "./diff";

describe("computeDiff", () => {
  it("returns empty array for identical content", () => {
    const result = computeDiff("hello\nworld", "hello\nworld");
    expect(result).toEqual([]);
  });

  it("detects a single added line", () => {
    const result = computeDiff("a\nb", "a\nb\nc");
    expect(result).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "added", text: "c" },
    ]);
  });

  it("detects a single removed line", () => {
    const result = computeDiff("a\nb\nc", "a\nb");
    expect(result).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "removed", text: "c" },
    ]);
  });

  it("detects a changed line as remove + add", () => {
    const result = computeDiff("a\nold\nc", "a\nnew\nc");
    expect(result).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "context", text: "c" },
    ]);
  });

  it("handles completely different content", () => {
    const result = computeDiff("a\nb", "c\nd");
    expect(result).toEqual([
      { type: "removed", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "c" },
      { type: "added", text: "d" },
    ]);
  });

  it("handles empty local content", () => {
    const result = computeDiff("", "new line");
    expect(result).toEqual([
      { type: "added", text: "new line" },
    ]);
  });

  it("handles empty remote content", () => {
    const result = computeDiff("old line", "");
    expect(result).toEqual([
      { type: "removed", text: "old line" },
    ]);
  });
});
