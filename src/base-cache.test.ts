/* eslint-disable obsidianmd/hardcoded-config-path */
import { describe, it, expect, beforeEach } from "vitest";
import { BaseCache } from "./base-cache";

function makeApp() {
  const store: Record<string, string> = {};
  return {
    vault: {
      configDir: ".obsidian",
      adapter: {
        read: async (path: string) => {
          if (path in store) return store[path]!;
          throw new Error("File not found");
        },
        write: async (path: string, data: string) => {
          store[path] = data;
        },
      },
    },
    _store: store,
  };
}

describe("BaseCache", () => {
  let app: ReturnType<typeof makeApp>;
  let cache: BaseCache;

  beforeEach(() => {
    app = makeApp();
    cache = new BaseCache(app as never, "sn-obsidian-sync");
  });

  it("returns null for missing sysId", async () => {
    expect(await cache.loadBase("unknown")).toBeNull();
  });

  it("round-trips save and load", async () => {
    await cache.saveBase("abc123", "## Section\n\nContent here");
    expect(await cache.loadBase("abc123")).toBe("## Section\n\nContent here");
  });

  it("returns null after removeBase", async () => {
    await cache.saveBase("abc123", "content");
    await cache.removeBase("abc123");
    expect(await cache.loadBase("abc123")).toBeNull();
  });

  it("persists across instances", async () => {
    await cache.saveBase("abc123", "persisted");
    const cache2 = new BaseCache(app as never, "sn-obsidian-sync");
    expect(await cache2.loadBase("abc123")).toBe("persisted");
  });

  it("handles corrupt cache file gracefully", async () => {
    app._store[".obsidian/plugins/sn-obsidian-sync/sync-base-cache.json"] = "not json{{{";
    const cache2 = new BaseCache(app as never, "sn-obsidian-sync");
    expect(await cache2.loadBase("anything")).toBeNull();
  });

  it("handles missing cache file gracefully", async () => {
    // No file in store — read will throw
    expect(await cache.loadBase("anything")).toBeNull();
  });

  it("stores multiple sysIds independently", async () => {
    await cache.saveBase("id1", "body1");
    await cache.saveBase("id2", "body2");
    expect(await cache.loadBase("id1")).toBe("body1");
    expect(await cache.loadBase("id2")).toBe("body2");
    await cache.removeBase("id1");
    expect(await cache.loadBase("id1")).toBeNull();
    expect(await cache.loadBase("id2")).toBe("body2");
  });

  it("uses correct cache path", async () => {
    await cache.saveBase("x", "y");
    const expectedPath = ".obsidian/plugins/sn-obsidian-sync/sync-base-cache.json";
    expect(expectedPath in app._store).toBe(true);
  });
});
