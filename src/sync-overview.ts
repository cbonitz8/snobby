/**
 * The Sync overview counters. Pure so the arithmetic is testable: the cards
 * must count the same population on both sides, or the pair reads as a gap
 * when nothing is actually out of sync.
 */
export interface SyncOverviewInput {
  /** sys_ids of every document the server returned. */
  serverIds: string[];
  /** sys_ids the plugin tracks locally (docMap keys). */
  docMapIds: string[];
  /** sys_ids the user chose to ignore — neither pulled nor pushed. */
  ignoredIds: string[];
  excludePathCount: number;
  conflictCount: number;
}

export interface SyncOverview {
  /** Server documents that are in scope for sync (ignored ones removed). */
  onServer: number;
  /** Tracked documents that are in scope for sync (ignored ones removed). */
  downloaded: number;
  /** Ignored documents — counted here instead of skewing the pair above. */
  ignored: number;
  excludedPaths: number;
  conflicts: number;
  /** In-scope server documents with no local copy yet. */
  notDownloaded: number;
}

export function computeSyncOverview(input: SyncOverviewInput): SyncOverview {
  const ignored = new Set(input.ignoredIds);
  const serverInScope = input.serverIds.filter((id) => !ignored.has(id));
  const trackedInScope = new Set(input.docMapIds.filter((id) => !ignored.has(id)));

  return {
    onServer: serverInScope.length,
    downloaded: trackedInScope.size,
    ignored: ignored.size,
    excludedPaths: input.excludePathCount,
    conflicts: input.conflictCount,
    notDownloaded: serverInScope.filter((id) => !trackedInScope.has(id)).length,
  };
}
