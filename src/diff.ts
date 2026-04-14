export interface DiffLine {
  type: "context" | "added" | "removed";
  text: string;
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
  if (local === remote) return [];

  const localLines = local ? local.split("\n") : [];
  const remoteLines = remote ? remote.split("\n") : [];
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
