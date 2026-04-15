import { describe, it, expect } from "vitest";
import { computeDiff, extractHunks, computeSideBySide, extractSideBySideHunks, type DiffLine, type SideBySideLine } from "./diff";

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

describe("computeSideBySide", () => {
  it("returns empty array for identical content", () => {
    const result = computeSideBySide("hello\nworld", "hello\nworld");
    expect(result).toEqual([]);
  });

  it("pairs context lines on both sides", () => {
    const result = computeSideBySide("a\nold\nc", "a\nnew\nc");
    expect(result).toContainEqual({
      left: { text: "a", type: "context" },
      right: { text: "a", type: "context" },
    });
    expect(result).toContainEqual({
      left: { text: "c", type: "context" },
      right: { text: "c", type: "context" },
    });
  });

  it("shows removed lines on left with null on right", () => {
    const result = computeSideBySide("a\nb\nc", "a\nc");
    const removedRow = result.find((r) => r.left?.text === "b");
    expect(removedRow).toBeDefined();
    expect(removedRow!.left).toEqual({ text: "b", type: "removed" });
    expect(removedRow!.right).toBeNull();
  });

  it("shows added lines on right with null on left", () => {
    const result = computeSideBySide("a\nc", "a\nb\nc");
    const addedRow = result.find((r) => r.right?.text === "b");
    expect(addedRow).toBeDefined();
    expect(addedRow!.left).toBeNull();
    expect(addedRow!.right).toEqual({ text: "b", type: "added" });
  });

  it("pairs changed lines side by side", () => {
    const result = computeSideBySide("a\nold\nc", "a\nnew\nc");
    const changedRow = result.find((r) => r.left?.text === "old");
    expect(changedRow).toBeDefined();
    expect(changedRow!.left).toEqual({ text: "old", type: "removed" });
    expect(changedRow!.right).toEqual({ text: "new", type: "added" });
  });

  it("handles multiple consecutive changes with unequal counts", () => {
    const result = computeSideBySide("a\nx\ny\nc", "a\np\nc");
    const xRow = result.find((r) => r.left?.text === "x");
    expect(xRow!.right).toEqual({ text: "p", type: "added" });
    const yRow = result.find((r) => r.left?.text === "y");
    expect(yRow!.right).toBeNull();
  });

  it("handles empty local content", () => {
    const result = computeSideBySide("", "new line");
    expect(result).toEqual([
      { left: null, right: { text: "new line", type: "added" } },
    ]);
  });

  it("handles empty remote content", () => {
    const result = computeSideBySide("old line", "");
    expect(result).toEqual([
      { left: { text: "old line", type: "removed" }, right: null },
    ]);
  });
});

describe("extractSideBySideHunks", () => {
  it("trims context-only lines and shows hunks with 3-line context", () => {
    // 10 identical lines, then 1 changed line, then 10 more identical
    const localLines = Array.from({ length: 21 }, (_, i) => i === 10 ? "OLD" : `line ${i}`);
    const remoteLines = Array.from({ length: 21 }, (_, i) => i === 10 ? "NEW" : `line ${i}`);
    const local = localLines.join("\n");
    const remote = remoteLines.join("\n");

    const allLines = computeSideBySide(local, remote);
    expect(allLines.length).toBe(21); // all 21 lines present

    const hunks = extractSideBySideHunks(allLines);
    expect(hunks.length).toBe(1);
    // 3 context before + 1 changed + 3 context after = 7
    expect(hunks[0]!.lines.length).toBe(7);
    // Changed line should be in the middle
    const changed = hunks[0]!.lines.find((l) => l.left?.type === "removed");
    expect(changed).toBeDefined();
    expect(changed!.left!.text).toBe("OLD");
    expect(changed!.right!.text).toBe("NEW");
  });
});
