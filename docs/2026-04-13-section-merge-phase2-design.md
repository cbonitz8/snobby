# Phase 2: Pull-Phase Section Merge Integration

## Goal

Wire the section merge engine (Phase 1) into the sync engine's pull path so that concurrent edits to different sections auto-merge silently, and same-section conflicts surface in the ConflictModal with section-level detail. Also clean up three untyped interface gaps discovered during audit.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Base storage | Client-side cache file via Obsidian adapter API | No SN schema changes. Graceful two-way fallback if cache lost. Revisit if collision frequency grows. |
| Cache location | `<configDir>/plugins/sn-obsidian-sync/sync-base-cache.json` | Separate from `data.json` to keep settings lean. Uses `app.vault.adapter` for Obsidian-compatible I/O. |
| When to merge | Only when local is dirty AND remote changed (conflict path) | Clean pull = overwrite as before. Merge only adds value when both sides changed. |
| ConflictEntry extension | Add optional `sectionConflicts` field | ConflictModal renders per-section when available, falls back to whole-file when not. |
| Auto-merge notification | Silent for v1 | Revisit after real usage — toasting every auto-merge could be noisy on shared standups. |

## Type Cleanups (baked into Phase 2)

Three untyped interface gaps to fix before wiring merge logic:

### 1. `applyConflict()` — positional params → typed object

**Before:** 5 positional strings, impossible to read at call sites:
```typescript
applyConflict(sysId: string, path: string, remoteContent: string, remoteTimestamp: string, lockedBy: string)
```

**After:** accepts `ConflictEntry` directly:
```typescript
applyConflict(entry: ConflictEntry): void
```

Callers build the entry at call site. Extensible — adding `sectionConflicts` is just a new optional field on `ConflictEntry`, no signature change.

### 2. `api-client.ts` — inline object types → named types

**Before:** anonymous inline objects for `createDocument` / `updateDocument`:
```typescript
async createDocument(doc: { title: string; content: string; ... })
async updateDocument(id: string, doc: { title?: string; content?: string; ... })
```

**After:** named types in `types.ts`:
```typescript
export type CreateDocumentPayload = Pick<SNDocument, "title" | "content" | "category" | "project" | "tags">;
export type UpdateDocumentPayload = Partial<CreateDocumentPayload>;
```

### 3. `stripFrontmatter()` — duplicated → shared utility

Identical logic in `sync-engine.ts:682` and `conflict-resolver.ts:162`. Extract to `frontmatter-manager.ts` as a static/exported function — it already owns frontmatter concerns:

```typescript
// In frontmatter-manager.ts
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).replace(/^\n+/, "");
}
```

Both `SyncEngine` and `ConflictResolver` import from `frontmatter-manager.ts`. Remove their private copies.

## Base Cache Module: `src/base-cache.ts`

Uses Obsidian's `app.vault.adapter` for all file I/O — no Node.js `fs`.

```typescript
export class BaseCache {
  private app: App;
  private cachePath: string;
  private cache: Record<string, string> | null;

  constructor(app: App, pluginId: string);

  async loadBase(sysId: string): Promise<string | null>;
  async saveBase(sysId: string, body: string): Promise<void>;
  async removeBase(sysId: string): Promise<void>;
}
```

- Storage format: `Record<string, string>` — sysId → body content
- File path: `${app.vault.configDir}/plugins/${pluginId}/sync-base-cache.json`
- Lazy-loaded on first access via `app.vault.adapter.read()`, cached in `this.cache`
- Writes via `app.vault.adapter.write()` after mutations
- If file missing or corrupt → `this.cache = {}`, return null (triggers two-way fallback)
- No direct plugin dependency — takes `App` and `pluginId` string

## Changes to `types.ts`

```typescript
// Extended ConflictEntry
export interface ConflictEntry {
  sysId: string;
  path: string;
  remoteContent: string;
  remoteTimestamp: string;
  lockedBy: string;
  sectionConflicts?: SectionConflict[];
}

// New API payload types
export type CreateDocumentPayload = Pick<SNDocument, "title" | "content" | "category" | "project" | "tags">;
export type UpdateDocumentPayload = Partial<CreateDocumentPayload>;
```

## Changes to `frontmatter-manager.ts`

Export standalone `stripFrontmatter` function (extracted from sync-engine + conflict-resolver):

```typescript
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).replace(/^\n+/, "");
}
```

Existing class methods unchanged.

## Changes to `api-client.ts`

```typescript
import type { CreateDocumentPayload, UpdateDocumentPayload, SNDocument, SNMetadata } from "./types";

async createDocument(doc: CreateDocumentPayload): Promise<ApiResponse<SNDocument>> { ... }
async updateDocument(id: string, doc: UpdateDocumentPayload): Promise<ApiResponse<SNDocument>> { ... }
```

## Changes to `conflict-resolver.ts`

1. `applyConflict(entry: ConflictEntry)` — takes typed object, not positional params
2. Import `stripFrontmatter` from `frontmatter-manager.ts` — remove private copy
3. `resolveWithPull` and `resolveWithPush` update base cache after resolution

```typescript
export class ConflictResolver {
  private plugin: SNSyncPlugin;
  private baseCache: BaseCache;

  constructor(plugin: SNSyncPlugin, baseCache: BaseCache);

  applyConflict(entry: ConflictEntry): void;
  async resolveWithPull(sysId: string): Promise<void>;   // saves remote body as base
  async resolveWithPush(sysId: string): Promise<void>;   // saves local body as base
  // ... rest unchanged
}
```

## Changes to `sync-engine.ts`

### Import shared `stripFrontmatter`

Remove private `stripFrontmatter()` method. Import from `frontmatter-manager.ts`.

### Constructor — accept `BaseCache`

```typescript
constructor(plugin: SNSyncPlugin, baseCache: BaseCache) {
  this.baseCache = baseCache;
  // ... rest unchanged
}
```

### `handlePulledDoc()` — conflict path (lines 388-391)

**Before:**
```typescript
if (fm.synced === false) {
  this.conflictResolver.applyConflict(doc.sys_id, mapEntry.path, doc.content, doc.sys_updated_on, doc.checked_out_by || "");
  result.conflicts++;
}
```

**After:**
```typescript
if (fm.synced === false) {
  const remoteBody = stripFrontmatter(doc.content);
  const baseBody = await this.baseCache.loadBase(doc.sys_id);
  const baseSections = baseBody ? parseSections(baseBody) : null;
  const localSections = parseSections(localBody);
  const remoteSections = parseSections(remoteBody);
  const mergeResult = mergeSections(baseSections, localSections, remoteSections);

  if (!mergeResult.hasConflicts) {
    this.fileWatcher.addSyncWritePath(file.path);
    const merged = await this.rebuildWithFrontmatter(file, mergeResult.mergedBody);
    await this.plugin.app.vault.modify(file, merged);
    await this.frontmatterManager.write(file, { ...fm, synced: true });
    this.fileWatcher.removeSyncWritePath(file.path);
    await this.baseCache.saveBase(doc.sys_id, mergeResult.mergedBody);
    mapEntry.lastServerTimestamp = doc.sys_updated_on;
    result.pulled++;
  } else {
    this.conflictResolver.applyConflict({
      sysId: doc.sys_id,
      path: mapEntry.path,
      remoteContent: doc.content,
      remoteTimestamp: doc.sys_updated_on,
      lockedBy: doc.checked_out_by || "",
      sectionConflicts: mergeResult.conflicts,
    });
    result.conflicts++;
  }
}
```

### `handlePulledDoc()` — clean pull path (lines 393-404)

Add base cache save after successful overwrite:

```typescript
// After existing line 403 (mapEntry.lastServerTimestamp = ...):
await this.baseCache.saveBase(doc.sys_id, stripFrontmatter(doc.content));
```

### `createLocalFile()` — new doc from remote

Add base cache save when a new remote doc is first pulled:

```typescript
// After file creation:
await this.baseCache.saveBase(doc.sys_id, stripFrontmatter(doc.content));
```

### Helper: `rebuildWithFrontmatter()`

New private method:

```typescript
private async rebuildWithFrontmatter(file: TFile, newBody: string): Promise<string> {
  const raw = await this.plugin.app.vault.read(file);
  if (!raw.startsWith("---")) return newBody;
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return newBody;
  return raw.substring(0, endIdx + 4) + "\n" + newBody;
}
```

### `applyConflict` call sites — update to typed object

Update the push-path `applyConflict` call (line ~502) to use typed `ConflictEntry` object too.

## Changes to `conflict-modal.ts`

When `conflict.sectionConflicts` exists and has entries:
- Show section conflict count in modal header ("2 section conflicts")
- List conflicting section headings with local/remote body previews
- Existing diff view still available for full-file comparison
- Accept Remote / Keep Local buttons still operate on whole file (per-section resolution is Phase 4-5)

v1 scope: informational section detail in modal. Resolution remains whole-file.

## Changes to `main.ts`

```typescript
import { BaseCache } from "./base-cache";

// In onload():
this.baseCache = new BaseCache(this.app, this.manifest.id);
this.conflictResolver = new ConflictResolver(this, this.baseCache);
this.syncEngine = new SyncEngine(this, this.baseCache);
```

## Base cache update points

| Event | Action |
|-------|--------|
| Clean pull (remote changed, local clean) | `saveBase(sysId, remoteBody)` |
| Auto-merge success (both changed, no conflicts) | `saveBase(sysId, mergedBody)` |
| Conflict resolved via "Accept Remote" | `saveBase(sysId, remoteBody)` |
| Conflict resolved via "Keep Local" | `saveBase(sysId, localBody)` |
| Successful push | `saveBase(sysId, pushedBody)` — Phase 3 |
| New doc created locally | No base yet — first push establishes it |
| New doc pulled from remote | `saveBase(sysId, remoteBody)` |

## Test plan

### base-cache
- Save and load round-trip
- Load missing sysId → null
- Remove base → subsequent load returns null
- Corrupt/missing cache file → null (no crash)
- Uses `app.vault.adapter` (not `fs`)

### type cleanups
- `applyConflict` accepts `ConflictEntry` object
- `createDocument` / `updateDocument` use `CreateDocumentPayload` / `UpdateDocumentPayload`
- `stripFrontmatter` imported from `frontmatter-manager`, not duplicated

### sync-engine integration (mocked dependencies)
- Pull with local dirty + remote changed + different sections → auto-merge, base updated
- Pull with local dirty + remote changed + same section → conflict with `sectionConflicts` populated
- Pull with local clean + remote changed → overwrite, base updated
- Pull with no base cached → two-way fallback
- `rebuildWithFrontmatter` preserves frontmatter, replaces body

### conflict-resolver
- `applyConflict` with `sectionConflicts` → stored in SyncState
- `applyConflict` without `sectionConflicts` → backwards compatible
- `resolveWithPull` updates base cache
- `resolveWithPush` updates base cache

### conflict-modal
- Renders section conflict detail when `sectionConflicts` present
- Falls back to whole-file diff when `sectionConflicts` absent

## Not in scope

- Push-phase integration (Phase 3)
- Per-section resolution UI (Phase 4-5)
- Auto-merge notifications (revisit after real usage)
- SN-side base storage (deferred — see design notes)
