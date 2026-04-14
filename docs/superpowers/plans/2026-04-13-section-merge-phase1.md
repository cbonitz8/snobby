# Phase 1: Section Parser + Merge Logic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone module that parses markdown into h3-delimited sections and performs three-way section-level merge with per-section conflict reporting.

**Architecture:** Three small modules — `content-hash.ts` (normalize + hash), `section-parser.ts` (parse/serialize h3 sections), `section-merger.ts` (three-way keyed merge). Each is pure functions, no Obsidian dependencies, fully unit-tested. Types added to `types.ts`.

**Tech Stack:** TypeScript, vitest

**Design spec:** `docs/2026-04-13-section-merge-phase1-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add `SectionBlock`, `SectionConflict`, `SectionOutcome`, `MergeResult` types; add `lastSyncedBody?` to `DocMapEntry` |
| `src/content-hash.ts` | Create | `normalizeContent()` and `contentHash()` |
| `src/content-hash.test.ts` | Create | Tests for normalization and hashing |
| `src/section-parser.ts` | Create | `parseSections()` and `serializeSections()` |
| `src/section-parser.test.ts` | Create | Tests for parsing, serialization, round-trip |
| `src/section-merger.ts` | Create | `mergeSections()` three-way merge |
| `src/section-merger.test.ts` | Create | Tests for all merge rules |

---

### Task 1: Add types to `types.ts`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add section merge types**

Add these types at the end of `src/types.ts`:

```typescript
export interface SectionBlock {
  heading: string;
  key: string;
  body: string;
  hash: string;
}

export interface SectionConflict {
  key: string;
  heading: string;
  localBody: string;
  remoteBody: string;
  baseBody: string | null;
}

export type SectionOutcome =
  | { status: "unchanged" }
  | { status: "accepted_remote"; body: string }
  | { status: "kept_local"; body: string }
  | { status: "added"; source: "local" | "remote"; body: string }
  | { status: "deleted"; source: "local" | "remote" }
  | { status: "conflict"; conflict: SectionConflict };

export interface MergeResult {
  mergedBody: string;
  outcomes: Map<string, SectionOutcome>;
  conflicts: SectionConflict[];
  hasConflicts: boolean;
}
```

- [ ] **Step 2: Add `lastSyncedBody` to `DocMapEntry`**

In the existing `DocMapEntry` interface in `src/types.ts`, add:

```typescript
export interface DocMapEntry {
  sysId: string;
  path: string;
  lastServerTimestamp: string;
  lockedBy: string;
  lockedAt: string;
  lastSyncedBody?: string;
}
```

- [ ] **Step 3: Verify build**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx tsc --noEmit --skipLibCheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add section merge types and lastSyncedBody to DocMapEntry"
```

---

### Task 2: Content hash module

**Files:**
- Create: `src/content-hash.ts`
- Create: `src/content-hash.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/content-hash.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeContent, contentHash } from "./content-hash";

describe("normalizeContent", () => {
  it("trims trailing whitespace per line", () => {
    expect(normalizeContent("hello   \nworld  ")).toBe("hello\nworld\n");
  });

  it("collapses multiple trailing newlines to one", () => {
    expect(normalizeContent("hello\nworld\n\n\n")).toBe("hello\nworld\n");
  });

  it("preserves leading whitespace", () => {
    expect(normalizeContent("  indented\n    more")).toBe("  indented\n    more\n");
  });

  it("handles empty string", () => {
    expect(normalizeContent("")).toBe("\n");
  });

  it("handles single newline", () => {
    expect(normalizeContent("\n")).toBe("\n");
  });

  it("handles content with no trailing whitespace", () => {
    expect(normalizeContent("clean\nlines")).toBe("clean\nlines\n");
  });
});

describe("contentHash", () => {
  it("returns same hash for identical content", () => {
    expect(contentHash("hello\nworld")).toBe(contentHash("hello\nworld"));
  });

  it("returns same hash when only trailing whitespace differs", () => {
    expect(contentHash("hello   \nworld  ")).toBe(contentHash("hello\nworld"));
  });

  it("returns same hash when trailing newlines differ", () => {
    expect(contentHash("hello\nworld\n\n\n")).toBe(contentHash("hello\nworld"));
  });

  it("returns different hash for different content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });

  it("returns a string", () => {
    expect(typeof contentHash("test")).toBe("string");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx vitest run src/content-hash.test.ts`
Expected: FAIL — module `./content-hash` not found

- [ ] **Step 3: Implement content-hash module**

Create `src/content-hash.ts`:

```typescript
/**
 * Normalize content for comparison: trim trailing whitespace per line,
 * collapse trailing newlines to a single newline.
 */
export function normalizeContent(content: string): string {
  const lines = content.split("\n").map((line) => line.trimEnd());
  // Remove empty trailing lines, then ensure single trailing newline
  while (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n") + "\n";
}

/**
 * cyrb53 — fast 53-bit non-crypto hash.
 * Returns hex string for readability.
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Hash content after normalization. Two strings that differ only in
 * trailing whitespace or trailing newlines produce the same hash.
 */
export function contentHash(content: string): string {
  return cyrb53(normalizeContent(content));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx vitest run src/content-hash.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/content-hash.ts src/content-hash.test.ts
git commit -m "feat: add content normalization and hashing module"
```

---

### Task 3: Section parser module

**Files:**
- Create: `src/section-parser.ts`
- Create: `src/section-parser.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/section-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseSections, serializeSections } from "./section-parser";

describe("parseSections", () => {
  it("returns preamble only for body with no headings", () => {
    const result = parseSections("Just some text\nand more text");
    expect(result.size).toBe(1);
    expect(result.has("__preamble")).toBe(true);
    expect(result.get("__preamble")!.body).toBe("Just some text\nand more text");
    expect(result.get("__preamble")!.heading).toBe("");
  });

  it("returns empty map for empty body", () => {
    const result = parseSections("");
    expect(result.size).toBe(0);
  });

  it("returns empty map for whitespace-only body", () => {
    const result = parseSections("   \n\n  ");
    expect(result.size).toBe(0);
  });

  it("parses multiple h3 sections", () => {
    const body = "### Alice\nAlice content\n\n### Bob\nBob content";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.get("alice")!.heading).toBe("### Alice");
    expect(result.get("alice")!.body).toBe("Alice content\n");
    expect(result.get("bob")!.heading).toBe("### Bob");
    expect(result.get("bob")!.body).toBe("Bob content");
  });

  it("preserves preamble before first heading", () => {
    const body = "Top content\n\n### Section\nSection body";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.get("__preamble")!.body).toBe("Top content\n");
    expect(result.get("section")!.body).toBe("Section body");
  });

  it("handles sections with blank lines in body", () => {
    const body = "### Notes\nLine 1\n\nLine 2\n\nLine 3\n\n### Other\nStuff";
    const result = parseSections(body);
    expect(result.get("notes")!.body).toBe("Line 1\n\nLine 2\n\nLine 3\n");
    expect(result.get("other")!.body).toBe("Stuff");
  });

  it("does not split on h1, h2, or h4 headings", () => {
    const body = "# Big\n## Medium\n### Real\nContent\n#### Small\nMore";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.has("__preamble")).toBe(true);
    expect(result.get("__preamble")!.body).toBe("# Big\n## Medium\n");
    expect(result.get("real")!.body).toBe("Content\n#### Small\nMore");
  });

  it("deduplicates heading keys with suffix", () => {
    const body = "### Dupe\nFirst\n### Dupe\nSecond";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.has("dupe")).toBe(true);
    expect(result.has("dupe-2")).toBe(true);
    expect(result.get("dupe")!.body).toBe("First\n");
    expect(result.get("dupe-2")!.body).toBe("Second");
  });

  it("computes hash from normalized content", () => {
    const body1 = "### Test\nContent   \n\n";
    const body2 = "### Test\nContent\n";
    const r1 = parseSections(body1);
    const r2 = parseSections(body2);
    expect(r1.get("test")!.hash).toBe(r2.get("test")!.hash);
  });
});

describe("serializeSections", () => {
  it("reconstructs preamble-only body", () => {
    const sections = parseSections("Just some text");
    const result = serializeSections(sections);
    expect(result).toBe("Just some text");
  });

  it("reconstructs sections with headings", () => {
    const body = "### Alice\nContent A\n\n### Bob\nContent B";
    const sections = parseSections(body);
    const result = serializeSections(sections);
    expect(result).toBe("### Alice\nContent A\n\n### Bob\nContent B");
  });

  it("reconstructs preamble + sections", () => {
    const body = "Top stuff\n\n### Section\nBody here";
    const sections = parseSections(body);
    const result = serializeSections(sections);
    expect(result).toBe("Top stuff\n\n### Section\nBody here");
  });

  it("round-trips complex document", () => {
    const body = [
      "Preamble line 1",
      "Preamble line 2",
      "",
      "### Alpha",
      "Alpha body",
      "",
      "Alpha continued",
      "",
      "### Beta",
      "Beta body",
      "",
      "### Gamma",
      "Gamma body",
    ].join("\n");
    const sections = parseSections(body);
    const result = serializeSections(sections);
    expect(result).toBe(body);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx vitest run src/section-parser.test.ts`
Expected: FAIL — module `./section-parser` not found

- [ ] **Step 3: Implement section parser**

Create `src/section-parser.ts`:

```typescript
import type { SectionBlock } from "./types";
import { contentHash } from "./content-hash";

const H3_REGEX = /^### .+/;
const PREAMBLE_KEY = "__preamble";

/**
 * Parse markdown body (no frontmatter) into h3-delimited sections.
 * Content before the first ### heading is stored under key "__preamble".
 */
export function parseSections(body: string): Map<string, SectionBlock> {
  const sections = new Map<string, SectionBlock>();
  if (!body || !body.trim()) return sections;

  const lines = body.split("\n");
  const keyCounts = new Map<string, number>();

  let currentKey: string | null = null;
  let currentHeading = "";
  let currentLines: string[] = [];

  function flush() {
    if (currentKey === null && currentLines.length === 0) return;

    const key = currentKey ?? PREAMBLE_KEY;
    const rawBody = currentLines.join("\n");
    const heading = currentHeading;

    const finalKey = deduplicateKey(key, keyCounts);
    sections.set(finalKey, {
      heading,
      key: finalKey,
      body: rawBody,
      hash: contentHash(rawBody),
    });
  }

  for (const line of lines) {
    if (H3_REGEX.test(line)) {
      flush();
      currentKey = line.replace(/^###\s+/, "").trim().toLowerCase();
      currentHeading = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

function deduplicateKey(
  key: string,
  counts: Map<string, number>,
): string {
  const count = counts.get(key) ?? 0;
  counts.set(key, count + 1);
  return count === 0 ? key : `${key}-${count + 1}`;
}

/**
 * Reconstruct markdown body from section map.
 * Preamble first (if present), then sections in map order.
 */
export function serializeSections(
  sections: Map<string, SectionBlock>,
): string {
  const parts: string[] = [];

  for (const [key, section] of sections) {
    if (key === PREAMBLE_KEY || key.startsWith(PREAMBLE_KEY)) {
      parts.push(section.body);
    } else {
      parts.push(section.heading + "\n" + section.body);
    }
  }

  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx vitest run src/section-parser.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Fix any failing tests, iterate**

If tests fail, inspect the specific assertion. The most likely issues:
- Trailing newline handling between sections — adjust `flush()` or `serializeSections` join logic
- Preamble blank line before first heading — check whether trailing `\n` is included in preamble body

Iterate until all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/section-parser.ts src/section-parser.test.ts
git commit -m "feat: add section parser with h3 splitting and round-trip serialization"
```

---

### Task 4: Section merger module

**Files:**
- Create: `src/section-merger.ts`
- Create: `src/section-merger.test.ts`

- [ ] **Step 1: Write failing tests for three-way merge**

Create `src/section-merger.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeSections } from "./section-merger";
import { parseSections } from "./section-parser";

// Helper: parse a markdown body into section map
function p(body: string) {
  return parseSections(body);
}

describe("mergeSections — three-way", () => {
  it("returns unchanged when all three are identical", () => {
    const base = p("### A\nContent");
    const local = p("### A\nContent");
    const remote = p("### A\nContent");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.conflicts).toHaveLength(0);
    expect(result.outcomes.get("a")!.status).toBe("unchanged");
  });

  it("accepts remote when only remote changed", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal");
    const remote = p("### A\nUpdated by remote");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("accepted_remote");
    expect(result.mergedBody).toContain("Updated by remote");
  });

  it("keeps local when only local changed", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nUpdated locally");
    const remote = p("### A\nOriginal");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("kept_local");
    expect(result.mergedBody).toContain("Updated locally");
  });

  it("detects conflict when both changed differently", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nLocal version");
    const remote = p("### A\nRemote version");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.key).toBe("a");
    expect(result.conflicts[0]!.localBody).toContain("Local version");
    expect(result.conflicts[0]!.remoteBody).toContain("Remote version");
    expect(result.conflicts[0]!.baseBody).toContain("Original");
  });

  it("treats convergent edits as unchanged", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nSame fix");
    const remote = p("### A\nSame fix");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("unchanged");
  });

  it("removes section deleted by remote", () => {
    const base = p("### A\nKeep\n\n### B\nRemove me");
    const local = p("### A\nKeep\n\n### B\nRemove me");
    const remote = p("### A\nKeep");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("deleted");
    expect(result.mergedBody).not.toContain("Remove me");
  });

  it("removes section deleted by local", () => {
    const base = p("### A\nKeep\n\n### B\nRemove me");
    const local = p("### A\nKeep");
    const remote = p("### A\nKeep\n\n### B\nRemove me");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("deleted");
    expect(result.mergedBody).not.toContain("Remove me");
  });

  it("removes section deleted by both", () => {
    const base = p("### A\nKeep\n\n### B\nGone");
    const local = p("### A\nKeep");
    const remote = p("### A\nKeep");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("deleted");
  });

  it("keeps section added locally", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal\n\n### B\nNew local");
    const remote = p("### A\nOriginal");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("added");
    expect(result.mergedBody).toContain("New local");
  });

  it("accepts section added remotely", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal");
    const remote = p("### A\nOriginal\n\n### B\nNew remote");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("added");
    expect(result.mergedBody).toContain("New remote");
  });

  it("no conflict when both add same section with same content", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal\n\n### B\nSame");
    const remote = p("### A\nOriginal\n\n### B\nSame");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
  });

  it("conflicts when both add same key with different content", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal\n\n### B\nLocal version");
    const remote = p("### A\nOriginal\n\n### B\nRemote version");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts[0]!.key).toBe("b");
    expect(result.conflicts[0]!.baseBody).toBeNull();
  });

  it("merges multiple sections independently", () => {
    const base = p("### A\nA base\n\n### B\nB base\n\n### C\nC base");
    const local = p("### A\nA local\n\n### B\nB base\n\n### C\nC base");
    const remote = p("### A\nA base\n\n### B\nB remote\n\n### C\nC base");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("kept_local");
    expect(result.outcomes.get("b")!.status).toBe("accepted_remote");
    expect(result.outcomes.get("c")!.status).toBe("unchanged");
    expect(result.mergedBody).toContain("A local");
    expect(result.mergedBody).toContain("B remote");
    expect(result.mergedBody).toContain("C base");
  });

  it("handles preamble changes", () => {
    const base = p("Preamble\n\n### A\nContent");
    const local = p("Updated preamble\n\n### A\nContent");
    const remote = p("Preamble\n\n### A\nContent");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("__preamble")!.status).toBe("kept_local");
    expect(result.mergedBody).toContain("Updated preamble");
  });
});

describe("mergeSections — two-way fallback (null base)", () => {
  it("returns unchanged when local and remote match", () => {
    const local = p("### A\nSame");
    const remote = p("### A\nSame");
    const result = mergeSections(null, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("unchanged");
  });

  it("keeps local-only section", () => {
    const local = p("### A\nLocal\n\n### B\nOnly here");
    const remote = p("### A\nLocal");
    const result = mergeSections(null, local, remote);
    expect(result.outcomes.get("b")!.status).toBe("kept_local");
  });

  it("accepts remote-only section", () => {
    const local = p("### A\nLocal");
    const remote = p("### A\nLocal\n\n### B\nRemote only");
    const result = mergeSections(null, local, remote);
    expect(result.outcomes.get("b")!.status).toBe("accepted_remote");
  });

  it("conflicts when same key has different content", () => {
    const local = p("### A\nLocal ver");
    const remote = p("### A\nRemote ver");
    const result = mergeSections(null, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts[0]!.baseBody).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx vitest run src/section-merger.test.ts`
Expected: FAIL — module `./section-merger` not found

- [ ] **Step 3: Implement section merger**

Create `src/section-merger.ts`:

```typescript
import type { SectionBlock, SectionConflict, SectionOutcome, MergeResult } from "./types";
import { serializeSections } from "./section-parser";

/**
 * Three-way section-level merge. Compares base/local/remote section maps
 * and produces a merged result with per-section outcomes.
 *
 * If base is null, falls back to two-way merge (no deletion detection).
 */
export function mergeSections(
  base: Map<string, SectionBlock> | null,
  local: Map<string, SectionBlock>,
  remote: Map<string, SectionBlock>,
): MergeResult {
  const allKeys = new Set<string>();
  if (base) for (const k of base.keys()) allKeys.add(k);
  for (const k of local.keys()) allKeys.add(k);
  for (const k of remote.keys()) allKeys.add(k);

  const outcomes = new Map<string, SectionOutcome>();
  const conflicts: SectionConflict[] = [];
  const merged = new Map<string, SectionBlock>();

  for (const key of allKeys) {
    const baseSection = base?.get(key) ?? null;
    const localSection = local.get(key) ?? null;
    const remoteSection = remote.get(key) ?? null;

    const outcome = base
      ? resolveThreeWay(key, baseSection, localSection, remoteSection)
      : resolveTwoWay(key, localSection, remoteSection);

    outcomes.set(key, outcome);

    if (outcome.status === "conflict") {
      conflicts.push(outcome.conflict);
      // Use local as placeholder in merged output
      if (localSection) merged.set(key, localSection);
    } else if (outcome.status === "deleted") {
      // Omit from merged output
    } else if (outcome.status === "unchanged") {
      // Prefer local copy (identical content)
      const section = localSection ?? remoteSection;
      if (section) merged.set(key, section);
    } else if (outcome.status === "accepted_remote") {
      if (remoteSection) merged.set(key, remoteSection);
    } else if (outcome.status === "kept_local") {
      if (localSection) merged.set(key, localSection);
    } else if (outcome.status === "added") {
      const section = outcome.source === "local" ? localSection : remoteSection;
      if (section) merged.set(key, section);
    }
  }

  return {
    mergedBody: serializeSections(merged),
    outcomes,
    conflicts,
    hasConflicts: conflicts.length > 0,
  };
}

function resolveThreeWay(
  key: string,
  base: SectionBlock | null,
  local: SectionBlock | null,
  remote: SectionBlock | null,
): SectionOutcome {
  const baseHash = base?.hash ?? null;
  const localHash = local?.hash ?? null;
  const remoteHash = remote?.hash ?? null;

  // Section exists in base
  if (baseHash !== null) {
    if (localHash === null && remoteHash === null) {
      return { status: "deleted", source: "local" };
    }
    if (localHash === null) {
      return { status: "deleted", source: "local" };
    }
    if (remoteHash === null) {
      return { status: "deleted", source: "remote" };
    }
    if (localHash === baseHash && remoteHash === baseHash) {
      return { status: "unchanged" };
    }
    if (localHash === baseHash && remoteHash !== baseHash) {
      return { status: "accepted_remote", body: remote!.body };
    }
    if (localHash !== baseHash && remoteHash === baseHash) {
      return { status: "kept_local", body: local!.body };
    }
    if (localHash === remoteHash) {
      return { status: "unchanged" }; // convergent
    }
    return {
      status: "conflict",
      conflict: {
        key,
        heading: local!.heading || remote!.heading,
        localBody: local!.body,
        remoteBody: remote!.body,
        baseBody: base!.body,
      },
    };
  }

  // Section not in base — new addition
  if (localHash !== null && remoteHash === null) {
    return { status: "added", source: "local", body: local!.body };
  }
  if (localHash === null && remoteHash !== null) {
    return { status: "added", source: "remote", body: remote!.body };
  }
  if (localHash !== null && remoteHash !== null) {
    if (localHash === remoteHash) {
      return { status: "added", source: "local", body: local!.body }; // convergent
    }
    return {
      status: "conflict",
      conflict: {
        key,
        heading: local!.heading || remote!.heading,
        localBody: local!.body,
        remoteBody: remote!.body,
        baseBody: null,
      },
    };
  }

  return { status: "unchanged" };
}

function resolveTwoWay(
  key: string,
  local: SectionBlock | null,
  remote: SectionBlock | null,
): SectionOutcome {
  const localHash = local?.hash ?? null;
  const remoteHash = remote?.hash ?? null;

  if (localHash === remoteHash) {
    return { status: "unchanged" };
  }
  if (localHash !== null && remoteHash === null) {
    return { status: "kept_local", body: local!.body };
  }
  if (localHash === null && remoteHash !== null) {
    return { status: "accepted_remote", body: remote!.body };
  }
  return {
    status: "conflict",
    conflict: {
      key,
      heading: local!.heading || remote!.heading,
      localBody: local!.body,
      remoteBody: remote!.body,
      baseBody: null,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx vitest run src/section-merger.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Fix any failing tests, iterate**

Most likely issues:
- Serialization order when remote adds a section not in local — check that `allKeys` iteration order produces correct `mergedBody`
- Trailing newline mismatches in `mergedBody` assertions — check `serializeSections` join behavior

Iterate until all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/section-merger.ts src/section-merger.test.ts
git commit -m "feat: add three-way section merger with per-section conflict reporting"
```

---

### Task 5: Full test suite run + build verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run all tests**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx vitest run`
Expected: All tests pass (content-hash, section-parser, section-merger, existing diff tests, existing folder-mapper tests, existing conflict-resolver tests)

- [ ] **Step 2: Run type check**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx tsc --noEmit --skipLibCheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npx eslint src/content-hash.ts src/section-parser.ts src/section-merger.ts`
Expected: No errors (or only warnings)

- [ ] **Step 4: Run build**

Run: `cd "/Users/caleb/git stuff/sn-obsidian-sync/sn-obsidian-sync" && npm run build`
Expected: Build succeeds, `main.js` generated

- [ ] **Step 5: Fix any issues and commit**

If lint or build issues arise, fix them and commit:

```bash
git add -A
git commit -m "fix: resolve lint/build issues in section merge modules"
```
