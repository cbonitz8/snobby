import { describe, it, expect } from "vitest";
import { computeDiff, extractHunks, type DiffLine } from "./diff";

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

describe("extractHunks", () => {
  it("returns empty array for no diff lines", () => {
    expect(extractHunks([])).toEqual([]);
  });

  it("returns a single hunk with context for a small diff", () => {
    const lines: DiffLine[] = [
      { type: "context", text: "a" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "context", text: "c" },
    ];
    const hunks = extractHunks(lines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toEqual(lines);
  });

  it("limits context to 3 lines before and after a change", () => {
    const lines: DiffLine[] = [
      { type: "context", text: "1" },
      { type: "context", text: "2" },
      { type: "context", text: "3" },
      { type: "context", text: "4" },
      { type: "context", text: "5" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "context", text: "6" },
      { type: "context", text: "7" },
      { type: "context", text: "8" },
      { type: "context", text: "9" },
      { type: "context", text: "10" },
    ];
    const hunks = extractHunks(lines);
    expect(hunks).toHaveLength(1);
    // 3 before + removed + added + 3 after = 8 lines
    expect(hunks[0]!.lines).toHaveLength(8);
    expect(hunks[0]!.lines[0]!.text).toBe("3");
    expect(hunks[0]!.lines[7]!.text).toBe("8");
  });

  it("merges overlapping hunks", () => {
    const lines: DiffLine[] = [
      { type: "removed", text: "a" },
      { type: "context", text: "1" },
      { type: "context", text: "2" },
      { type: "context", text: "3" },
      { type: "context", text: "4" },
      { type: "context", text: "5" },
      { type: "added", text: "b" },
    ];
    const hunks = extractHunks(lines);
    // gap is 5 context lines; 3 after first + 3 before second = 6 > 5 → merge
    expect(hunks).toHaveLength(1);
  });

  it("splits distant hunks", () => {
    const lines: DiffLine[] = [
      { type: "removed", text: "a" },
      { type: "context", text: "1" },
      { type: "context", text: "2" },
      { type: "context", text: "3" },
      { type: "context", text: "4" },
      { type: "context", text: "5" },
      { type: "context", text: "6" },
      { type: "context", text: "7" },
      { type: "added", text: "b" },
    ];
    const hunks = extractHunks(lines);
    // gap is 7 context lines; 3 + 3 = 6 < 7 → split
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines[0]!.text).toBe("a");
    expect(hunks[1]!.lines[hunks[1]!.lines.length - 1]!.text).toBe("b");
  });
});
