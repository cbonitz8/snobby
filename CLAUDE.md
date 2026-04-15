# Snobby — SN Obsidian Sync

Bidirectional sync between Obsidian and ServiceNow via Scripted REST API. Obsidian plugin (desktop only).

## Quick Reference

- **Build:** `npm run build` (tsc + esbuild)
- **Dev:** `npm run dev` (watch mode)
- **Test:** `npm test` (vitest)
- **Lint:** `npm run lint` (eslint with obsidianmd plugin)
- **Version:** 0.2.2

## Architecture

Six core modules composed by `SNSyncPlugin` in `src/main.ts`:

| Module | File | Responsibility |
|--------|------|----------------|
| `AuthManager` | `auth-manager.ts` | OAuth 2.0 flow, token storage, auto-refresh |
| `ApiClient` | `api-client.ts` | REST calls (CRUD, checkout/checkin, getChanges, metadata) |
| `SyncEngine` | `sync-engine.ts` | Pull/push orchestration, bulk ops, initial pull |
| `FileWatcher` | `file-watcher.ts` | Vault event monitoring, debounce, dirty flagging |
| `FrontmatterManager` | `frontmatter-manager.ts` | Read/write SN frontmatter fields via Obsidian API |
| `ConflictResolver` | `conflict-resolver.ts` | Conflict detection, per-section resolution, resolution strategies |

Supporting modules:
- `section-parser.ts` / `section-merger.ts` — Section-level merge for conflict resolution
- `content-hash.ts` — Content comparison (avoids false conflicts from metadata-only changes)
- `diff.ts` — Diff utilities
- `folder-mapper.ts` — Maps SN metadata to vault folder structure
- `sn-browser-view.ts` — Custom view for browsing SN documents
- `new-doc-modal.ts` — Modal for new document metadata

- `settings.ts` — Settings tab + defaults
- `types.ts` — All shared interfaces

## Sync Cycle

Pull runs before push every cycle:
1. **Pull** — fetch changes since last sync, compare content, handle conflicts
2. **Push** — find files with `sn_synced: false`, checkout → update → checkin

## Key Patterns

- Frontmatter fields prefixed with `sn_` (configurable): `sn_sys_id`, `sn_category`, `sn_project`, `sn_tags`, `sn_synced`
- Document locking via checkout/checkin endpoints
- Conflict fallback: section-level merge, then git-style markers
- Folder placement derived from SN category/project metadata
- OAuth redirect via `obsidian://sn-obsidian-sync/callback` protocol handler

## Testing

- Vitest with Obsidian mocks in `src/__mocks__/obsidian.ts`
- Test files colocated: `*.test.ts` next to source
- Tests exist for: conflict-resolver, content-hash, diff, folder-mapper, section-merger, section-parser

## TypeScript Config

- Strict null checks, no implicit any/this/returns
- `noUncheckedIndexedAccess: true` — indexed access returns `T | undefined`
- Target ES6, module ESNext
- Path alias: `obsidian` → mock in tests

## Obsidian Vault Integration

- **Vault name:** Configured in plugin settings (`settings.vaultName`, e.g. "Ethos")
- **Vault path:** Configured in plugin settings (`settings.vaultPath`)

## Conventions

- ESM (`"type": "module"` in package.json)
- Non-null assertions (`!`) used for Obsidian API values known to exist
- Plugin state persisted via `this.loadData()` / `this.saveData()` (Obsidian API)
- Status bar shows sync state, clickable for manual sync
