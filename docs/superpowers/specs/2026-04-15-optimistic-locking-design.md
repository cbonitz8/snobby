# Optimistic Locking via Content Hash — Design Spec

**Date:** 2026-04-15
**Status:** Draft

## Goal

Prevent silent overwrites during sync by adding server-side content hash validation. When a client pushes, the server rejects if the document changed since the client last synced. Uses SN audit history for ancestor lookup to enable true three-way merge on conflict.

## Problem

Current conflict detection relies on client-side state (base cache + `sn_synced` flag). Failure modes:
- Base cache null or stale → `localDirty` = false → remote overwrites local silently
- Race window: edit → push → remote changes arrive → `synced` is true → overwrite
- Multi-device: device B's base cache doesn't reflect device A's push → wrong merge ancestor
- Plugin reinstall / cache loss → no base → no conflict detection

Root cause: the common ancestor lives only in a local JSON file.

## Design

### 1. Content Hash on Doc Table

**New field on `u_ethos_md`:** `u_content_hash` (string, 32 chars)

Stores MD5 hex digest of the normalized document content. Updated on every content write (API or direct).

**What gets hashed:** The full content as stored in `u_content` — user frontmatter + body. This is exactly what `getContentForPush()` produces (local file with `sn_`-prefixed fields stripped). The `sn_` fields only exist locally and never reach SN, so they're not part of the hash. No frontmatter stripping needed — hash the content as SN stores it.

**Normalization (both sides must match):**
1. `\r\n` → `\n`, stray `\r` → `\n`
2. Trim trailing whitespace per line
3. Collapse trailing newlines to single `\n`
4. MD5 hex digest of result

**SN side:** Implement normalization in Scripted REST API JS. Use `GlideDigest.getMD5Hex(normalizedContent)`. Hashes `u_content` directly (already has no `sn_` fields).

**Plugin side:** Implement same normalization. Hash output of `getContentForPush()` (which already strips `sn_` fields, keeps user frontmatter + body). Use Node `crypto.createHash('md5')`.

### 2. API Changes

All changes piggyback on existing endpoints. No new endpoints.

**PUT `/documents/:id` (update):**
- Accept optional `expected_hash` in request body
- If `expected_hash` present:
  - Compare against stored `u_content_hash`
  - Match → proceed with update, compute + store new hash, return updated doc with hash
  - Mismatch → return 409 with:
    ```json
    {
      "conflict": true,
      "content_hash": "<current hash>",
      "content": "<current full content>",
      "sys_updated_on": "<timestamp>",
      "ancestor_content": "<body at client's expected_hash version>"
    }
    ```
  - Ancestor lookup: query `sys_audit` for `u_content` field, find the version whose hash matches `expected_hash`. Return that body as `ancestor_content`. If not found (hash too old, audit pruned), return `null` — client falls back to two-way merge.
- If `expected_hash` absent → backward compatible, update proceeds without validation (existing clients still work during rollout)

**GET `/documents`, `/documents/:id`, `/documents/changes`:**
- Include `content_hash` in response alongside existing fields

**POST `/documents` (create):**
- Compute and store `u_content_hash` on creation
- Return hash in response

### 3. Ancestor Lookup via sys_audit

When push returns 409, the server finds the common ancestor:

```javascript
// Find the audit record where content matched client's expected_hash
// IMPORTANT: only query u_content field — not other audited fields
var gr = new GlideRecord('sys_audit');
gr.addQuery('tablename', 'u_ethos_md');
gr.addQuery('documentkey', docSysId);
gr.addQuery('fieldname', 'u_content');  // content changes only
gr.orderByDesc('sys_created_on');
gr.query();
while (gr.next()) {
  var content = gr.getValue('newvalue');
  if (md5(normalize(content)) === expectedHash) {
    return content; // This is the common ancestor
  }
}
return null; // Ancestor not found — client uses two-way merge
```

This gives Git-like three-way merge: the server provides the exact content the client last saw, enabling precise conflict resolution.

### 4. Plugin Changes

**`SNDocument` type:**
```
+ content_hash: string
```

**`DocMapEntry` type:**
```
+ contentHash: string
```

**On pull (`handlePulledDoc`):**
- Store `content_hash` from response in `DocMapEntry.contentHash`
- Use for next push's `expected_hash`

**On push (`handlePushFile`):**
- Send `expected_hash: docMapEntry.contentHash` in PUT body
- Success → update `DocMapEntry.contentHash` from response
- 409 → create `ConflictEntry` with:
  - `remoteContent` from 409 response body
  - `ancestorContent` from 409 response (new field on `ConflictEntry`)
  - If `ancestor_content` present → use as base for three-way section merge (replaces base cache lookup)
  - If `ancestor_content` null → fall back to base cache, then two-way merge

**Conflict detection simplification:**
- Server hash check is now the authority for "has remote changed?"
- Client only needs to know "has local changed?" → `sn_synced === false`
- Base cache remains for providing merge base content (backup when ancestor not in audit)
- Remove the fragile `baseBody !== null && localBody !== baseBody` check from dirty detection — server handles it

**`ConflictEntry` type:**
```
+ ancestorContent?: string  // Body from server's audit lookup
```

**`assemblePerSectionMerge` enhancement:**
- If `ancestorContent` available on ConflictEntry, use it as base instead of base cache
- Falls through to base cache if absent

### 5. Backfill

One-time script to hash all existing docs:

```javascript
var gr = new GlideRecord('u_ethos_md');
gr.query();
while (gr.next()) {
  var hash = computeContentHash(gr.getValue('u_content'));
  gr.setValue('u_content_hash', hash);
  gr.setWorkflow(false); // Skip business rules
  gr.update();
}
```

### 6. Normalization Contract

Both sides MUST produce identical output. Test with known inputs during implementation:

| Input | Expected normalized |
|-------|--------------------|
| `"---\ndate: x\n---\nhello\n"` | `"---\ndate: x\n---\nhello\n"` |
| `"hello  \nworld\n\n\n"` | `"hello\nworld\n"` |
| `"hello\r\nworld\r\n"` | `"hello\nworld\n"` |
| `"no frontmatter\n"` | `"no frontmatter\n"` |
| `"---\ndate: x\n---\n\n\nbody\n"` | `"---\ndate: x\n---\n\nbody\n"` |

Shared test vectors — run on both plugin and SN to verify match.

## Scope Boundary

**In scope (this spec):**
- `u_content_hash` field + backfill
- API changes (send/receive/validate hash)
- Ancestor lookup via `sys_audit`
- Plugin: send hash on push, store hash from pull, use ancestor in merge
- Normalization module (shared logic)

**Out of scope (sync ledger — separate spec):**
- Per-device sync tracking
- Audit trail for who synced when
- Multi-device conflict ordering

## Testing

- [ ] Normalization test vectors: identical output plugin ↔ SN
- [ ] Push with matching hash → succeeds, hash updated
- [ ] Push with stale hash → 409 with current content + ancestor
- [ ] Push with stale hash, ancestor not in audit → 409 with null ancestor
- [ ] Push without expected_hash → backward compatible, succeeds
- [ ] Pull includes content_hash in response
- [ ] Conflict resolution uses ancestor_content for three-way merge
- [ ] Backfill script hashes all existing docs correctly
