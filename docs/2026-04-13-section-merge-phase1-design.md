# Phase 1: Section Parser + Merge Logic

## Goal

Standalone module that parses markdown into h3-delimited sections and performs three-way section-level merge. Foundation for Phases 2-8 — no integration with sync engine yet.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Section boundary | `###` (h3) only | Matches standup convention. Flat map, no nesting. Widen later if needed. |
| Frontmatter | Excluded from parser | `frontmatter-manager.ts` handles separately. Parser operates on body content only. |
| Merge strategy | Three-way (base + local + remote) | Two-way can't distinguish deletions from additions. Same impl effort, avoids throwaway work. |
| Content comparison | Normalized + hashed | Trim trailing whitespace per line, collapse trailing newlines, then hash. Avoids false conflicts from editor differences. |

## Types

```typescript
interface SectionBlock {
  heading: string;       // e.g. "### caleb" — full heading line
  key: string;           // normalized heading text, lowercase trimmed (e.g. "caleb")
  body: string;          // raw content between this heading and next (preserves whitespace for round-trip)
  hash: string;          // hash of normalized body (trimmed/collapsed) for quick comparison
}

interface SectionConflict {
  key: string;
  heading: string;
  localBody: string;
  remoteBody: string;
  baseBody: string | null;
}

type SectionOutcome =
  | { status: 'unchanged' }
  | { status: 'accepted_remote'; body: string }
  | { status: 'kept_local'; body: string }
  | { status: 'added'; source: 'local' | 'remote'; body: string }
  | { status: 'deleted'; source: 'local' | 'remote' }
  | { status: 'conflict'; conflict: SectionConflict };

interface MergeResult {
  /** Ready-to-write merged body (conflicts use local version as placeholder) */
  mergedBody: string;
  /** Per-section outcomes keyed by section key */
  outcomes: Map<string, SectionOutcome>;
  /** Conflicted sections only — convenience accessor */
  conflicts: SectionConflict[];
  /** True if any section conflicted */
  hasConflicts: boolean;
}
```

### SyncState extension (type only — populated by Phase 2)

```typescript
// Added to DocMapEntry
interface DocMapEntry {
  // ... existing fields
  lastSyncedBody?: string;  // base snapshot for three-way merge
}
```

## Module: `section-parser.ts`

### `parseSections(body: string): Map<string, SectionBlock>`

- Input: markdown body (no frontmatter)
- Split on lines matching `/^### .+/`
- Content before first `###` heading → stored under key `"__preamble"`
- Each section: extract heading line, derive key (lowercase, trimmed text after `### `), capture body until next `###` or EOF
- Normalize body: trim trailing whitespace per line, collapse trailing newlines to single `\n`
- Hash: simple string hash of normalized body
- Duplicate keys: append `-2`, `-3`, etc. (edge case safety)

### `serializeSections(sections: Map<string, SectionBlock>): string`

- Reconstruct markdown from section map
- Preamble first (if exists), then sections in map insertion order
- Preserve original heading lines
- Single blank line between sections

## Module: `section-merger.ts`

### `mergeSections(base: Map | null, local: Map, remote: Map): MergeResult`

- If `base` is null → degrade to two-way (first sync, no base yet)
- Collect all keys across base + local + remote

**Three-way merge rules:**

| Base | Local | Remote | Outcome |
|------|-------|--------|---------|
| Same | Same | Same | `unchanged` |
| Has | Same as base | Changed | `accepted_remote` |
| Has | Changed | Same as base | `kept_local` |
| Has | Changed | Changed (different) | `conflict` |
| Has | Changed | Changed (same) | `unchanged` (convergent edit) |
| Has | Has | Missing | `deleted` (remote deleted) |
| Has | Missing | Has | `deleted` (local deleted) |
| Has | Missing | Missing | `deleted` (both deleted) |
| Missing | Exists | Missing | `added` (local) |
| Missing | Missing | Exists | `added` (remote) |
| Missing | Exists | Exists (same) | `added` (local — convergent) |
| Missing | Exists | Exists (different) | `conflict` (both added, different content) |

**Two-way fallback (no base):**

| Local | Remote | Outcome |
|-------|--------|---------|
| Same hash | Same hash | `unchanged` |
| Exists | Missing | `kept_local` |
| Missing | Exists | `accepted_remote` |
| Different hash | Different hash | `conflict` |

- Build `mergedBody` via `serializeSections` using resolved sections (conflicts use local as placeholder)
- Return structured `MergeResult`

## Module: `content-hash.ts`

### `normalizeContent(body: string): string`

- Trim trailing whitespace per line
- Collapse multiple trailing newlines to single `\n`
- Return normalized string

### `contentHash(body: string): string`

- Normalize, then simple hash (e.g. cyrb53 or similar non-crypto hash)
- Fast comparison, not security

## File layout

```
src/
  section-parser.ts       # parseSections, serializeSections
  section-merger.ts       # mergeSections
  content-hash.ts         # normalizeContent, contentHash
  section-parser.test.ts  # unit tests
  section-merger.test.ts  # unit tests
  content-hash.test.ts    # unit tests
```

## Test plan

### section-parser
- Empty body → empty map (or preamble only)
- Body with no headings → single `__preamble` section
- Multiple `###` sections → correct map with keys
- Preamble + sections → preamble preserved
- Duplicate headings → deduplicated keys with suffix
- Whitespace normalization → trailing spaces stripped, trailing newlines collapsed
- Round-trip: `serializeSections(parseSections(body))` preserves content

### content-hash
- Identical content → same hash
- Trailing whitespace difference → same hash (after normalize)
- Different content → different hash

### section-merger (three-way)
- All sections unchanged → no conflicts, body unchanged
- Remote-only change → auto-accept remote
- Local-only change → auto-keep local
- Both changed same section differently → conflict with both bodies
- Both changed same section identically → convergent, no conflict
- Remote deleted section → removed from output
- Local deleted section → removed from output
- New section added locally → kept
- New section added remotely → accepted
- Both added same key, different content → conflict
- No base (null) → two-way fallback rules apply
- Preamble changes → handled like any section

## Not in scope (later phases)

- Sync engine integration (Phase 2-3)
- Conflict UI (Phase 4-5)
- Presence (Phase 6-8)
- Heading depths other than h3
- Manual merge editor (`strategy: 'manual'`)
