import { describe, it, expect } from "vitest";
import { computeSyncOverview } from "./sync-overview";

function ids(...names: string[]) {
  return names;
}

describe("computeSyncOverview", () => {
  it("counts the same population on both sides — ignored docs skew neither", () => {
    const overview = computeSyncOverview({
      serverIds: ids("a", "b", "c", "ign1", "ign2"),
      docMapIds: ids("a", "b", "c", "ign1"),
      ignoredIds: ids("ign1", "ign2"),
      excludePathCount: 0,
      conflictCount: 0,
    });

    expect(overview.onServer).toBe(3);
    expect(overview.downloaded).toBe(3);
    expect(overview.ignored).toBe(2);
    expect(overview.notDownloaded).toBe(0);
  });

  it("reports server docs with no local copy", () => {
    const overview = computeSyncOverview({
      serverIds: ids("a", "b", "c"),
      docMapIds: ids("a"),
      ignoredIds: [],
      excludePathCount: 0,
      conflictCount: 0,
    });

    expect(overview.onServer).toBe(3);
    expect(overview.downloaded).toBe(1);
    expect(overview.notDownloaded).toBe(2);
  });

  it("a tracked doc the server no longer has does not become a negative gap", () => {
    const overview = computeSyncOverview({
      serverIds: ids("a"),
      docMapIds: ids("a", "deleted-on-server"),
      ignoredIds: [],
      excludePathCount: 0,
      conflictCount: 0,
    });

    expect(overview.onServer).toBe(1);
    expect(overview.downloaded).toBe(2);
    expect(overview.notDownloaded).toBe(0);
  });

  it("passes through exclude and conflict counts", () => {
    const overview = computeSyncOverview({
      serverIds: [],
      docMapIds: [],
      ignoredIds: [],
      excludePathCount: 4,
      conflictCount: 2,
    });

    expect(overview.excludedPaths).toBe(4);
    expect(overview.conflicts).toBe(2);
  });
});
