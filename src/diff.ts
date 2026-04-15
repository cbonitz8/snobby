export interface DiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

export interface SideBySideCell {
  text: string;
  type: "context" | "added" | "removed";
}

export interface SideBySideLine {
  left: SideBySideCell | null;
  right: SideBySideCell | null;
}

/**
 * Compute the longest common subsequence of two string arrays.
 * Returns an array of [indexInA, indexInB] pairs for matched lines.
 */
function lcs(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const pairs: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return pairs.reverse();
}

/**
 * Compute a line-level diff between local and remote content.
 * Returns DiffLine[] with only changed hunks and surrounding context.
 * Returns empty array if contents are identical.
 */
export function computeDiff(local: string, remote: string): DiffLine[] {
  // Normalize \r\n → \n (SN may use \r\n, Obsidian uses \n)
  const normalLocal = local.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const normalRemote = remote.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalLocal === normalRemote) return [];

  const localLines = normalLocal ? normalLocal.split("\n") : [];
  const remoteLines = normalRemote ? normalRemote.split("\n") : [];
  const matched = lcs(localLines, remoteLines);

  // Build full diff sequence
  const full: DiffLine[] = [];
  let li = 0;
  let ri = 0;

  for (const [ml, mr] of matched) {
    while (li < ml) {
      full.push({ type: "removed", text: localLines[li]! });
      li++;
    }
    while (ri < mr) {
      full.push({ type: "added", text: remoteLines[ri]! });
      ri++;
    }
    full.push({ type: "context", text: localLines[ml]! });
    li = ml + 1;
    ri = mr + 1;
  }

  while (li < localLines.length) {
    full.push({ type: "removed", text: localLines[li]! });
    li++;
  }
  while (ri < remoteLines.length) {
    full.push({ type: "added", text: remoteLines[ri]! });
    ri++;
  }

  return full;
}

export interface Hunk {
  lines: DiffLine[];
}

const CONTEXT_LINES = 3;

/**
 * Group diff lines into hunks showing only changed regions with surrounding context.
 * Adjacent hunks whose context would overlap are merged.
 */
export function extractHunks(diffLines: DiffLine[]): Hunk[] {
  if (diffLines.length === 0) return [];

  // Find indices of all changed lines
  const changeIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i]!.type !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Build raw hunks: each change gets a range with context
  const ranges: [number, number][] = [];
  let rangeStart = Math.max(0, changeIndices[0]! - CONTEXT_LINES);
  let rangeEnd = Math.min(diffLines.length - 1, changeIndices[0]! + CONTEXT_LINES);

  for (let i = 1; i < changeIndices.length; i++) {
    const newStart = Math.max(0, changeIndices[i]! - CONTEXT_LINES);
    const newEnd = Math.min(diffLines.length - 1, changeIndices[i]! + CONTEXT_LINES);

    if (newStart <= rangeEnd + 1) {
      // Overlapping or adjacent — extend current range
      rangeEnd = newEnd;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = newStart;
      rangeEnd = newEnd;
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  return ranges.map(([start, end]) => ({
    lines: diffLines.slice(start, end + 1),
  }));
}

export interface SideBySideHunk {
  lines: SideBySideLine[];
}

/**
 * Extract hunks from side-by-side lines, showing only changed regions
 * with surrounding context. Same logic as extractHunks but for SideBySideLine[].
 */
export function extractSideBySideHunks(sideBySideLines: SideBySideLine[]): SideBySideHunk[] {
  if (sideBySideLines.length === 0) return [];

  const changeIndices: number[] = [];
  for (let i = 0; i < sideBySideLines.length; i++) {
    const line = sideBySideLines[i]!;
    const isContext = line.left?.type === "context" && line.right?.type === "context";
    if (!isContext) {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  const ranges: [number, number][] = [];
  let rangeStart = Math.max(0, changeIndices[0]! - CONTEXT_LINES);
  let rangeEnd = Math.min(sideBySideLines.length - 1, changeIndices[0]! + CONTEXT_LINES);

  for (let i = 1; i < changeIndices.length; i++) {
    const newStart = Math.max(0, changeIndices[i]! - CONTEXT_LINES);
    const newEnd = Math.min(sideBySideLines.length - 1, changeIndices[i]! + CONTEXT_LINES);

    if (newStart <= rangeEnd + 1) {
      rangeEnd = newEnd;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = newStart;
      rangeEnd = newEnd;
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  return ranges.map(([start, end]) => ({
    lines: sideBySideLines.slice(start, end + 1),
  }));
}

/**
 * Compute a side-by-side diff between local and remote content.
 * Returns paired lines: context on both sides, removed on left only,
 * added on right only. Adjacent removed+added runs are paired row-by-row.
 * Returns empty array if contents are identical.
 */
export function computeSideBySide(local: string, remote: string): SideBySideLine[] {
  const diffLines = computeDiff(local, remote);
  if (diffLines.length === 0) return [];

  const result: SideBySideLine[] = [];
  let i = 0;

  while (i < diffLines.length) {
    const line = diffLines[i]!;

    if (line.type === "context") {
      result.push({
        left: { text: line.text, type: "context" },
        right: { text: line.text, type: "context" },
      });
      i++;
      continue;
    }

    // Collect consecutive removed + added runs
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < diffLines.length && diffLines[i]!.type === "removed") {
      removed.push(diffLines[i]!);
      i++;
    }
    while (i < diffLines.length && diffLines[i]!.type === "added") {
      added.push(diffLines[i]!);
      i++;
    }

    const maxLen = Math.max(removed.length, added.length);
    for (let j = 0; j < maxLen; j++) {
      const leftLine = removed[j] ?? null;
      const rightLine = added[j] ?? null;
      result.push({
        left: leftLine ? { text: leftLine.text, type: "removed" } : null,
        right: rightLine ? { text: rightLine.text, type: "added" } : null,
      });
    }
  }

  return result;
}
