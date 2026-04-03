# SN Browser View — Design Spec

## Overview

A custom Obsidian `ItemView` that lets users browse documents on their ServiceNow instance, selectively download them, manage sync status, and control which vault files are excluded from syncing. Opens as a main pane tab by default but can be dragged to any workspace position.

---

## Layout

Two-pane view with two internal tabs: **Browse SN** and **Sync Settings**.

### Browse SN Tab

**Left pane: Tree navigation**
- Documents grouped by project → category, expandable/collapsible
- Doc counts shown per folder node (e.g., `EGCS Audits (31)`)
- Right-click a folder → "Exclude from sync"
- Tree respects active filters

**Right pane: Document list**
- Shows documents for the selected tree node
- Each row displays: checkbox, status icon, title, category badge, last updated date, last editor, checked-out-by indicator
- Single click toggles checkbox selection
- Double-click opens locally if synced, or prompts to download

**Top bar: Filters + actions**
- Filter dropdowns: Project, Category, Status (All / Synced / Not downloaded / Local changes / Conflicts)
- Search text input (filters by title)
- "Select Mode" toggle for batch operations
- Action buttons: "Download Selected", "Download All"

**Status icons:**
- `●` green — synced locally
- `○` gray — on server only (not downloaded)
- `◐` orange — local changes pending push
- `⚠` red — conflict
- `🔒` blue — checked out by someone

### Sync Settings Tab

**Excluded paths** — list of folders/files/patterns excluded from sync
- Each entry shows the path with a remove button
- "Add exclusion" button with a folder/file picker
- Supports folder paths (`Templates/`) and glob patterns (`*.canvas`)

**Sync overview stats** — quick summary
- Total docs on server
- Downloaded locally
- Pending push
- Excluded paths count

---

## Data Flow

### On view open (Browse tab)
1. Fetch `getDocuments()` from SN API — get full server doc list
2. Fetch `getMetadata()` — populate filter dropdowns
3. Cross-reference with `syncState.docMap` — determine which docs are already local
4. Build tree from project/category groupings
5. Cache results — don't re-fetch on every tab switch

### On download
- Reuse `SyncEngine.createLocalFile()` — handles folder creation, frontmatter, collision detection, docMap tracking
- Update the view row to show synced status after download completes
- Show progress notice for batch downloads

### Exclude list
- Stored in plugin settings as `excludePaths: string[]`
- FileWatcher checks excludes before marking files dirty
- `getDirtyFiles()` filters out excluded paths
- SyncEngine skips excluded files during push

---

## Sync Gating

Files are only considered for sync if they have `sn_category` in frontmatter. This is the primary gate. The exclude list is a secondary filter for files that have SN frontmatter but the user doesn't want synced (e.g., archived docs they downloaded for reference but don't want to push changes to).

---

## Module Changes

| Module | Change |
|--------|--------|
| `src/sn-browser-view.ts` | New file — `ItemView` subclass with two-pane Browse + Sync Settings tabs |
| `src/main.ts` | Register view type, add "Open SN Browser" command, expose apiClient/syncEngine to view |
| `src/types.ts` | Add `excludePaths: string[]` to `SNSyncSettings` |
| `src/settings.ts` | Add `excludePaths: []` to defaults |
| `src/file-watcher.ts` | Check exclude list in `getDirtyFiles()` and event handlers |
| `src/sync-engine.ts` | Expose `createLocalFile()` as public for the browser view to use |
| `styles.css` | Tree view, document list, filter bar, tab styles |

---

## Commands

| Command | Description |
|---------|-------------|
| Open SN Browser | Opens the browser view as a tab |

---

## Out of Scope

- Editing documents in the browser view (use the Obsidian editor)
- Deleting documents from SN via the browser
- Real-time updates (view refreshes on open or manual refresh button)
- Drag-and-drop reordering
