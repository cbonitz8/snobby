/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { TFile } from "obsidian";
import { SyncEngine, computeLocalHash } from "./sync-engine";
import { stripFrontmatter } from "./frontmatter-manager";
import { md5Hash } from "./content-hash";
import type {
  SNDocument,
  SNFrontmatter,
  SyncResult,
  SyncState,
  SNSyncSettings,
  DocMapEntry,
  ConflictEntry,
  FolderMapping,
  SNMetadata,
} from "./types";

// ---------------------------------------------------------------------------
// Mock: promptNewDocMetadata (avoid actual UI modal)
// ---------------------------------------------------------------------------
vi.mock("./new-doc-modal", () => ({
  promptNewDocMetadata: vi.fn().mockResolvedValue({
    category: "kb_knowledge",
    project: "proj1",
    tags: "tag1",
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFolderMapping(): FolderMapping {
  return {
    projects: true,
    categories: {
      kb_knowledge: { root: "Knowledge", subfolders: ["Articles"], topLevel: false },
    },
    custom: [],
  };
}

function makeSettings(overrides: Partial<SNSyncSettings> = {}): SNSyncSettings {
  return {
    instanceUrl: "https://test.service-now.com",
    apiPath: "/api/x_snob/ethos",
    metadataPath: "/api/x_snob/ethos/metadata",
    oauthRedirectUri: "obsidian://sn-obsidian-sync/callback",
    oauthClientId: "client_id",
    oauthClientSecret: "client_secret",
    syncMode: "manual",
    syncIntervalSeconds: 60,
    frontmatterPrefix: "sn_",
    localDeleteBehavior: "ignore",
    remoteDeleteBehavior: "keep local",
    folderMapping: makeFolderMapping(),
    excludePaths: [],
    userSysId: "",
    userDisplayName: "admin",
    vaultName: "TestVault",
    vaultPath: "/test",
    ...overrides,
  };
}

function makeSyncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    lastSyncTimestamp: "2026-01-01 00:00:00",
    ignoredIds: [],
    docMap: {},
    conflicts: {},
    ...overrides,
  };
}

function makeDoc(overrides: Partial<SNDocument> = {}): SNDocument {
  return {
    sys_id: "doc1",
    title: "Test Doc",
    content: "Hello world",
    category: "kb_knowledge",
    project: "proj1",
    tags: "tag1",
    sys_updated_on: "2026-01-02 00:00:00",
    content_hash: "hash1",
    ...overrides,
  };
}

function makeTFile(path: string, basename?: string, mtime?: number): TFile {
  const file = new TFile();
  (file as any).path = path;
  (file as any).name = path.split("/").pop() ?? path;
  (file as any).basename = basename ?? (file as any).name.replace(/\.md$/, "");
  (file as any).extension = "md";
  file.stat.mtime = mtime ?? Date.now();
  return file;
}

// ---------------------------------------------------------------------------
// Mock: Vault (in-memory file system)
// ---------------------------------------------------------------------------

function makeVault() {
  const files = new Map<string, string>();
  const tfiles = new Map<string, TFile>();

  const vault = {
    _files: files,
    _tfiles: tfiles,

    addFile(path: string, content: string, tfile?: TFile) {
      files.set(path, content);
      const f = tfile ?? makeTFile(path);
      tfiles.set(path, f);
      return f;
    },

    read: vi.fn(async (file: TFile) => {
      const content = files.get((file as any).path);
      if (content === undefined) throw new Error(`File not found: ${(file as any).path}`);
      return content;
    }),

    modify: vi.fn(async (file: TFile, content: string) => {
      files.set((file as any).path, content);
      file.stat.mtime = Date.now();
    }),

    create: vi.fn(async (path: string, content: string) => {
      const f = makeTFile(path);
      files.set(path, content);
      tfiles.set(path, f);
      return f;
    }),

    createFolder: vi.fn(async () => {}),

    getAbstractFileByPath: vi.fn((path: string) => {
      return tfiles.get(path) ?? null;
    }),

    getMarkdownFiles: vi.fn(() => {
      return Array.from(tfiles.values());
    }),

    adapter: {
      read: vi.fn(async (path: string) => files.get(path) ?? ""),
      write: vi.fn(async (path: string, data: string) => { files.set(path, data); }),
      exists: vi.fn(async (path: string) => files.has(path)),
      mkdir: vi.fn(async () => {}),
    },
  };
  return vault;
}

// ---------------------------------------------------------------------------
// Mock: Plugin
// ---------------------------------------------------------------------------

function makePlugin(settingsOverrides: Partial<SNSyncSettings> = {}, stateOverrides: Partial<SyncState> = {}) {
  const vault = makeVault();
  const plugin = {
    settings: makeSettings(settingsOverrides),
    syncState: makeSyncState(stateOverrides),
    app: {
      vault,
      fileManager: {
        processFrontMatter: vi.fn(),
        trashFile: vi.fn(),
      },
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue(null),
      },
    },
    saveSettings: vi.fn().mockResolvedValue(undefined),
    updateStatusBar: vi.fn(),
    updateSyncProgress: vi.fn(),
    refreshBrowserView: vi.fn(),
    registerInterval: vi.fn(),
    openConflictInBrowser: vi.fn().mockResolvedValue(undefined),
  };
  return plugin;
}

// ---------------------------------------------------------------------------
// Mock: ApiClient
// ---------------------------------------------------------------------------

function makeApiClient() {
  return {
    getChanges: vi.fn().mockResolvedValue({ ok: true, data: [], status: 200 }),
    getDocuments: vi.fn().mockResolvedValue({ ok: true, data: [], status: 200 }),
    getDocument: vi.fn().mockResolvedValue({ ok: true, data: null, status: 200 }),
    updateDocument: vi.fn().mockResolvedValue({ ok: true, data: { sys_updated_on: "2026-01-03 00:00:00", content_hash: "newhash" }, status: 200 }),
    createDocument: vi.fn().mockResolvedValue({ ok: true, data: makeDoc({ sys_id: "new1", sys_updated_on: "2026-01-03 00:00:00", content_hash: "newhash" }), status: 200 }),
    getMetadata: vi.fn().mockResolvedValue({
      ok: true,
      data: { categories: [{ value: "kb_knowledge", label: "Knowledge" }], projects: [{ value: "proj1", label: "Project 1" }], tags: ["tag1"] } as SNMetadata,
      status: 200,
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock: FrontmatterManager
// ---------------------------------------------------------------------------

function makeFrontmatterManager() {
  const state = new Map<string, SNFrontmatter>();
  return {
    _state: state,

    read: vi.fn((file: TFile): SNFrontmatter => {
      return state.get((file as any).path) ?? {};
    }),

    write: vi.fn(async (file: TFile, fields: Partial<SNFrontmatter>) => {
      const existing = state.get((file as any).path) ?? {};
      state.set((file as any).path, { ...existing, ...fields });
    }),

    markDirty: vi.fn(async (file: TFile) => {
      const existing = state.get((file as any).path) ?? {};
      state.set((file as any).path, { ...existing, synced: false });
    }),

    markSynced: vi.fn(async (file: TFile) => {
      const existing = state.get((file as any).path) ?? {};
      state.set((file as any).path, { ...existing, synced: true });
    }),

    clearSysId: vi.fn(async () => {}),
    updatePrefix: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock: FileWatcher
// ---------------------------------------------------------------------------

function makeFileWatcher(dirtyFiles: TFile[] = []) {
  return {
    addSyncWritePath: vi.fn(),
    removeSyncWritePath: vi.fn(),
    getDirtyFiles: vi.fn(() => dirtyFiles),
    isExcluded: vi.fn(() => false),
    flushPending: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock: ConflictResolver
// ---------------------------------------------------------------------------

function makeConflictResolver() {
  return {
    applyConflict: vi.fn(),
    getConflictForPath: vi.fn().mockReturnValue(null),
    getAllConflicts: vi.fn().mockReturnValue([]),
    resolveWithPull: vi.fn(),
    resolveWithPush: vi.fn(),
    resolvePerSection: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock: BaseCache
// ---------------------------------------------------------------------------

function makeBaseCache() {
  const store = new Map<string, string>();
  return {
    _store: store,
    loadBase: vi.fn(async (sysId: string) => store.get(sysId) ?? null),
    saveBase: vi.fn(async (sysId: string, body: string) => { store.set(sysId, body); }),
    removeBase: vi.fn(async (sysId: string) => { store.delete(sysId); }),
  };
}

// ---------------------------------------------------------------------------
// Factory: build a SyncEngine with all mocks wired
// ---------------------------------------------------------------------------

function buildEngine(opts: {
  settingsOverrides?: Partial<SNSyncSettings>;
  stateOverrides?: Partial<SyncState>;
  dirtyFiles?: TFile[];
} = {}) {
  const plugin = makePlugin(opts.settingsOverrides, opts.stateOverrides);
  const apiClient = makeApiClient();
  const fm = makeFrontmatterManager();
  const fw = makeFileWatcher(opts.dirtyFiles ?? []);
  const cr = makeConflictResolver();
  const bc = makeBaseCache();

  const engine = new SyncEngine(
    plugin as any,
    apiClient as any,
    fm as any,
    fw as any,
    cr as any,
    bc as any,
  );

  return { engine, plugin, apiClient, fm, fw, cr, bc };
}

// Convenience: invoke private methods
function callPull(engine: SyncEngine, result: SyncResult): Promise<string | null> {
  return (engine as any).pull(result);
}

function callPush(engine: SyncEngine, result: SyncResult): Promise<string | null> {
  return (engine as any).push(result);
}

function callHandlePulledDoc(engine: SyncEngine, doc: SNDocument, result: SyncResult): Promise<void> {
  return (engine as any).handlePulledDoc(doc, result);
}

function callHandlePushFile(engine: SyncEngine, file: TFile, result: SyncResult): Promise<string | null> {
  return (engine as any).handlePushFile(file, result);
}

function callDiscoverNewDocs(engine: SyncEngine, result: SyncResult): Promise<void> {
  return (engine as any).discoverNewDocs(result);
}

function freshResult(): SyncResult {
  return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
}

// ==========================================================================
// TESTS
// ==========================================================================

describe("handlePulledDoc — server hash unchanged", () => {
  it("updates mapEntry timestamp when server hash matches stored hash", async () => {
    const { engine, plugin } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Hello world");
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1",
      path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00",
      contentHash: "samehash",
      localContentHash: md5Hash("Hello world"),
    };
    const doc = makeDoc({ content: "Hello world", sys_updated_on: "2026-01-05 00:00:00", content_hash: "samehash" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.syncState.docMap["doc1"]!.lastServerTimestamp).toBe("2026-01-05 00:00:00");
  });

  it("does not increment result.pulled", async () => {
    const { engine, plugin } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Hello world");
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "samehash",
    };
    const doc = makeDoc({ content: "Hello world", sys_updated_on: "2026-01-05 00:00:00", content_hash: "samehash" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(result.pulled).toBe(0);
  });

  it("does not update base cache or engage syncWritePaths", async () => {
    const { engine, plugin, bc, fw } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Hello world");
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "samehash",
    };
    const doc = makeDoc({ content: "Hello world", content_hash: "samehash" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(bc.saveBase).not.toHaveBeenCalled();
    expect(fw.addSyncWritePath).not.toHaveBeenCalled();
  });
});

describe("handlePulledDoc — content changed, local clean", () => {
  function setup() {
    const ctx = buildEngine();
    const { plugin, fm } = ctx;
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "Old content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge", synced: true });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash("Old content"),
    };
    return { ...ctx, file };
  }

  it("writes remote content to file via vault.modify", async () => {
    const { engine, plugin } = setup();
    const doc = makeDoc({ content: "New content from server", sys_updated_on: "2026-01-05 00:00:00" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.app.vault.modify).toHaveBeenCalled();
    const modifyCall = plugin.app.vault.modify.mock.calls[0]!;
    expect(modifyCall[1]).toBe("New content from server");
  });

  it("writes frontmatter with synced: true", async () => {
    const { engine, fm } = setup();
    const doc = makeDoc({ content: "New content from server" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(fm.write).toHaveBeenCalled();
    const writeCall = fm.write.mock.calls[0]!;
    expect(writeCall[1].synced).toBe(true);
  });

  it("saves base cache with stripped content", async () => {
    const { engine, bc } = setup();
    const doc = makeDoc({ content: "---\nsn_sys_id: doc1\n---\nBody from server" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(bc.saveBase).toHaveBeenCalledWith("doc1", stripFrontmatter("---\nsn_sys_id: doc1\n---\nBody from server"));
  });

  it("updates mapEntry timestamps", async () => {
    const { engine, plugin } = setup();
    const doc = makeDoc({ content: "New content", sys_updated_on: "2026-02-01 00:00:00", content_hash: "hash99" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.syncState.docMap["doc1"]!.lastServerTimestamp).toBe("2026-02-01 00:00:00");
    expect(plugin.syncState.docMap["doc1"]!.contentHash).toBe("hash99");
  });

  it("increments result.pulled", async () => {
    const { engine } = setup();
    const doc = makeDoc({ content: "New content" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(result.pulled).toBe(1);
  });
});

describe("handlePulledDoc — content changed, local dirty, merge succeeds", () => {
  // Use multi-section content where each side changes a DIFFERENT section so merge succeeds
  const baseContent = "### Section A\n\nOriginal A\n\n### Section B\n\nOriginal B\n";
  const localContent = "### Section A\n\nLocal changed A\n\n### Section B\n\nOriginal B\n";
  const remoteContent = "### Section A\n\nOriginal A\n\n### Section B\n\nRemote changed B\n";

  function setup(useBase: boolean = true) {
    const ctx = buildEngine();
    const { plugin, fm, bc } = ctx;
    plugin.app.vault.addFile("Knowledge/doc.md", localContent);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge", synced: false });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash(baseContent), // hash of content at last sync — differs from current file
    };
    if (useBase) {
      bc._store.set("doc1", baseContent);
    }
    return ctx;
  }

  it("writes merged body to file", async () => {
    const { engine, plugin } = setup();
    const doc = makeDoc({ content: remoteContent });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.app.vault.modify).toHaveBeenCalled();
  });

  it("sets synced to false for re-push", async () => {
    const { engine, fm } = setup();
    const doc = makeDoc({ content: remoteContent });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(fm.write).toHaveBeenCalled();
    const writeCall = fm.write.mock.calls[0]!;
    expect(writeCall[1].synced).toBe(false);
  });

  it("saves base cache with merged body", async () => {
    const { engine, bc } = setup();
    const doc = makeDoc({ content: remoteContent });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(bc.saveBase).toHaveBeenCalled();
  });

  it("increments result.pulled", async () => {
    const { engine } = setup();
    const doc = makeDoc({ content: remoteContent });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(result.pulled).toBe(1);
  });

  it("works with null base cache (two-way fallback)", async () => {
    // Two-way merge (null base) can only cleanly merge when sections are unique to one side.
    const sharedSection = "### Section A\n\nShared content\n";
    const localOnly = sharedSection + "\n### Section B\n\nLocal-only section\n";
    const remoteOnly = sharedSection + "\n### Section C\n\nRemote-only section\n";

    const ctx = buildEngine();
    const { engine, plugin, fm } = ctx;
    plugin.app.vault.addFile("Knowledge/doc.md", localOnly);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash(sharedSection), // hash at last sync differs from current
    };
    // No base cache (null)

    const doc = makeDoc({ content: remoteOnly });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.app.vault.modify).toHaveBeenCalled();
    expect(result.pulled).toBe(1);
  });
});

describe("handlePulledDoc — content changed, local dirty, merge conflicts", () => {
  function setup() {
    const ctx = buildEngine();
    const { plugin, fm, bc } = ctx;
    const base = "### Section A\n\nOriginal A content\n";
    const local = "### Section A\n\nLocal changed A content\n";
    plugin.app.vault.addFile("Knowledge/doc.md", local);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge", synced: false });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash(base), // hash at last sync — differs from current local
    };
    bc._store.set("doc1", base);
    return ctx;
  }

  it("calls applyConflict with correct data", async () => {
    const { engine, cr } = setup();
    const remoteContent = "### Section A\n\nRemote changed A content\n";
    const doc = makeDoc({ content: remoteContent, sys_updated_on: "2026-01-05 00:00:00" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(cr.applyConflict).toHaveBeenCalled();
    const arg = cr.applyConflict.mock.calls[0]![0];
    expect(arg.sysId).toBe("doc1");
    expect(arg.path).toBe("Knowledge/doc.md");
    expect(arg.remoteContent).toBe(remoteContent);
    expect(arg.remoteTimestamp).toBe("2026-01-05 00:00:00");
  });

  it("increments result.conflicts", async () => {
    const { engine } = setup();
    const doc = makeDoc({ content: "### Section A\n\nRemote changed A content\n" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(result.conflicts).toBe(1);
  });

  it("does NOT modify the file", async () => {
    const { engine, plugin } = setup();
    const doc = makeDoc({ content: "### Section A\n\nRemote changed A content\n" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.app.vault.modify).not.toHaveBeenCalled();
  });

  it("does NOT save base cache", async () => {
    const { engine, bc } = setup();
    const doc = makeDoc({ content: "### Section A\n\nRemote changed A content\n" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(bc.saveBase).not.toHaveBeenCalled();
  });
});

describe("handlePulledDoc — legacy entry fallback (no localContentHash)", () => {
  it("detects local changes via base cache when localContentHash is undefined", async () => {
    const { engine, plugin, fm, bc } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Local changed content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      // No localContentHash — legacy entry
    };
    bc._store.set("doc1", "Original base content");

    const doc = makeDoc({ content: "Remote content" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    // local body !== base body → localChanged → merge/conflict path
    const modifyCalled = plugin.app.vault.modify.mock.calls.length > 0;
    const conflictCalled = (engine as any).conflictResolver.applyConflict.mock.calls.length > 0;
    expect(modifyCalled || conflictCalled).toBe(true);
  });

  it("treats as clean when localContentHash undefined and base matches local", async () => {
    const { engine, plugin, fm, bc } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Same content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };
    bc._store.set("doc1", "Same content");

    const doc = makeDoc({ content: "Remote content" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    // local body === base body → clean → overwrite with remote
    expect(plugin.app.vault.modify).toHaveBeenCalled();
    expect(result.pulled).toBe(1);
  });

  it("treats as clean when localContentHash undefined and no base cache", async () => {
    const { engine, plugin, fm } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Local content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };
    // No base cache, no localContentHash

    const doc = makeDoc({ content: "Remote content" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    // No way to detect changes → treat as clean → overwrite
    expect(plugin.app.vault.modify).toHaveBeenCalled();
    expect(result.pulled).toBe(1);
  });
});

describe("handlePulledDoc — skipPullSysIds", () => {
  it("returns immediately when doc is in skipPullSysIds", async () => {
    const { engine, plugin, fw, bc } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Old content");
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };

    engine.addSkipPullId("doc1");
    const doc = makeDoc({ content: "Remote content" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(result.pulled).toBe(0);
    expect(plugin.app.vault.modify).not.toHaveBeenCalled();
    expect(bc.saveBase).not.toHaveBeenCalled();
    expect(fw.addSyncWritePath).not.toHaveBeenCalled();
  });

  it("clears skipPullSysIds after push()", async () => {
    const { engine } = buildEngine();
    engine.addSkipPullId("doc1");
    engine.addSkipPullId("doc2");

    const result = freshResult();
    await callPush(engine, result);

    // After push, skip set should be cleared — next pull should process
    // Verify by calling handlePulledDoc and seeing it's not skipped
    const { engine: engine2, plugin: plugin2 } = buildEngine();
    // The original engine's skipPullSysIds should be cleared
    const doc = makeDoc({ sys_id: "doc1", content: "test" });
    const result2 = freshResult();
    // Instead, just verify through the push path that it works
    expect((engine as any).skipPullSysIds.size).toBe(0);
  });
});

describe("handlePulledDoc — new document / missing file", () => {
  it("creates a new local file when no mapEntry exists", async () => {
    const { engine, plugin, apiClient } = buildEngine();
    // Ensure ensureMetadata resolves
    apiClient.getMetadata.mockResolvedValue({
      ok: true,
      data: { categories: [{ value: "kb_knowledge", label: "Knowledge" }], projects: [{ value: "proj1", label: "Project 1" }], tags: ["tag1"] },
      status: 200,
    });

    const doc = makeDoc({ content: "New doc content", category: "kb_knowledge", project: "proj1" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.app.vault.create).toHaveBeenCalled();
    expect(result.pulled).toBe(1);
  });

  it("creates a local file when mapEntry exists but file is missing", async () => {
    const { engine, plugin, apiClient } = buildEngine();
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };
    // File not in vault (getAbstractFileByPath returns null)

    apiClient.getMetadata.mockResolvedValue({
      ok: true,
      data: { categories: [{ value: "kb_knowledge", label: "Knowledge" }], projects: [{ value: "proj1", label: "Project 1" }], tags: ["tag1"] },
      status: 200,
    });

    const doc = makeDoc({ content: "Replacement content" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(plugin.app.vault.create).toHaveBeenCalled();
    expect(result.pulled).toBe(1);
  });

  it("increments result.pulled for new documents", async () => {
    const { engine, apiClient } = buildEngine();
    apiClient.getMetadata.mockResolvedValue({
      ok: true,
      data: { categories: [{ value: "kb_knowledge", label: "Knowledge" }], projects: [{ value: "proj1", label: "Project 1" }], tags: ["tag1"] },
      status: 200,
    });

    const doc = makeDoc();
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    expect(result.pulled).toBe(1);
  });
});

describe("pull — orchestration", () => {
  it("returns null when lastSyncTimestamp is empty", async () => {
    const { engine, plugin } = buildEngine({ stateOverrides: { lastSyncTimestamp: "" } });
    const result = freshResult();
    const ts = await callPull(engine, result);

    expect(ts).toBeNull();
  });

  it("returns null when API fails", async () => {
    const { engine, apiClient } = buildEngine();
    apiClient.getChanges.mockResolvedValue({ ok: false, data: null, status: 500 });

    const result = freshResult();
    const ts = await callPull(engine, result);

    expect(ts).toBeNull();
    expect(result.errors).toHaveLength(1);
  });

  it("processes multiple docs and returns latest timestamp", async () => {
    const { engine, plugin, apiClient } = buildEngine();

    const doc1 = makeDoc({ sys_id: "d1", content: "C1", sys_updated_on: "2026-01-02 00:00:00", category: "kb_knowledge", project: "proj1" });
    const doc2 = makeDoc({ sys_id: "d2", content: "C2", sys_updated_on: "2026-01-05 00:00:00", category: "kb_knowledge", project: "proj1" });
    apiClient.getChanges.mockResolvedValue({ ok: true, data: [doc1, doc2], status: 200 });

    apiClient.getMetadata.mockResolvedValue({
      ok: true,
      data: { categories: [{ value: "kb_knowledge", label: "Knowledge" }], projects: [{ value: "proj1", label: "Project 1" }], tags: [] },
      status: 200,
    });

    const result = freshResult();
    const ts = await callPull(engine, result);

    expect(ts).toBe("2026-01-05 00:00:00");
  });

  it("skips docs in ignoredIds", async () => {
    const { engine, plugin, apiClient } = buildEngine({
      stateOverrides: { ignoredIds: ["ignored1"] },
    });

    const doc1 = makeDoc({ sys_id: "ignored1", content: "ignored", sys_updated_on: "2026-01-03 00:00:00", category: "kb_knowledge" });
    const doc2 = makeDoc({ sys_id: "kept1", content: "kept", sys_updated_on: "2026-01-04 00:00:00", category: "kb_knowledge", project: "proj1" });
    apiClient.getChanges.mockResolvedValue({ ok: true, data: [doc1, doc2], status: 200 });

    apiClient.getMetadata.mockResolvedValue({
      ok: true,
      data: { categories: [{ value: "kb_knowledge", label: "Knowledge" }], projects: [{ value: "proj1", label: "Project 1" }], tags: [] },
      status: 200,
    });

    const result = freshResult();
    await callPull(engine, result);

    // Only doc2 should have been processed (created)
    expect(result.pulled).toBe(1);
  });
});

describe("push — handlePushFile", () => {
  it("successful update: markSynced, base cache saved, mapEntry updated", async () => {
    const { engine, plugin, apiClient, fm, bc, fw } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "---\nsn_sys_id: doc1\nsn_synced: false\n---\nPush content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", synced: false });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };

    apiClient.updateDocument.mockResolvedValue({
      ok: true,
      data: { sys_updated_on: "2026-01-10 00:00:00", content_hash: "pushedhash" },
      status: 200,
    });

    const result = freshResult();
    const ts = await callHandlePushFile(engine, file, result);

    expect(fm.markSynced).toHaveBeenCalled();
    expect(bc.saveBase).toHaveBeenCalled();
    expect(plugin.syncState.docMap["doc1"]!.lastServerTimestamp).toBe("2026-01-10 00:00:00");
    expect(plugin.syncState.docMap["doc1"]!.contentHash).toBe("pushedhash");
    expect(result.pushed).toBe(1);
    expect(ts).toBe("2026-01-10 00:00:00");
  });

  it("409 with matching content: converged, markSynced", async () => {
    const { engine, plugin, apiClient, fm, bc } = buildEngine();
    const pushBody = "Same content";
    const file = plugin.app.vault.addFile("Knowledge/doc.md", pushBody);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", synced: false });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };

    apiClient.updateDocument.mockResolvedValue({
      ok: false,
      data: {
        conflict: true,
        content_hash: "convergedhash",
        content: "Same content",
        sys_updated_on: "2026-01-05 00:00:00",
        ancestor_content: null,
      },
      status: 409,
    });

    const result = freshResult();
    await callHandlePushFile(engine, file, result);

    expect(fm.markSynced).toHaveBeenCalled();
    expect(result.pushed).toBe(1);
  });

  it("409 with differing content + merge succeeds: merged written, markDirty", async () => {
    const { engine, plugin, apiClient, fm, bc } = buildEngine();
    // Local has section A changed, remote has section B changed
    const localContent = "### Section A\n\nLocal A\n\n### Section B\n\nOriginal B\n";
    const remoteContent = "### Section A\n\nOriginal A\n\n### Section B\n\nRemote B\n";
    const ancestorContent = "### Section A\n\nOriginal A\n\n### Section B\n\nOriginal B\n";

    const file = plugin.app.vault.addFile("Knowledge/doc.md", localContent);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", synced: false });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };

    apiClient.updateDocument.mockResolvedValue({
      ok: false,
      data: {
        conflict: true,
        content_hash: "conflicthash",
        content: remoteContent,
        sys_updated_on: "2026-01-05 00:00:00",
        ancestor_content: ancestorContent,
      },
      status: 409,
    });

    const result = freshResult();
    await callHandlePushFile(engine, file, result);

    // Merge should succeed (non-overlapping changes) → markDirty for re-push
    expect(fm.markDirty).toHaveBeenCalled();
    expect(plugin.app.vault.modify).toHaveBeenCalled();
    expect(bc.saveBase).toHaveBeenCalled();
  });

  it("409 with differing content + merge conflicts: applyConflict called", async () => {
    const { engine, plugin, apiClient, fm, cr, bc } = buildEngine();
    // Both sides changed the same section
    const base = "### Section A\n\nOriginal content\n";
    const localContent = "### Section A\n\nLocal changed content\n";
    const remoteContent = "### Section A\n\nRemote changed content\n";

    const file = plugin.app.vault.addFile("Knowledge/doc.md", localContent);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", synced: false });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };

    apiClient.updateDocument.mockResolvedValue({
      ok: false,
      data: {
        conflict: true,
        content_hash: "conflicthash",
        content: remoteContent,
        sys_updated_on: "2026-01-05 00:00:00",
        ancestor_content: base,
      },
      status: 409,
    });

    const result = freshResult();
    await callHandlePushFile(engine, file, result);

    expect(cr.applyConflict).toHaveBeenCalled();
    expect(result.conflicts).toBe(1);
  });

  it("new file (no sys_id): createDocument called", async () => {
    const { engine, plugin, apiClient, fm, bc } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/new-doc.md", "Brand new content");
    fm._state.set("Knowledge/new-doc.md", { category: "kb_knowledge", project: "proj1" });

    const newDoc = makeDoc({
      sys_id: "created1",
      sys_updated_on: "2026-01-10 00:00:00",
      content_hash: "createdhash",
      category: "kb_knowledge",
      project: "proj1",
      tags: "tag1",
    });
    apiClient.createDocument.mockResolvedValue({ ok: true, data: newDoc, status: 201 });

    const result = freshResult();
    const ts = await callHandlePushFile(engine, file, result);

    expect(apiClient.createDocument).toHaveBeenCalled();
    expect(result.pushed).toBe(1);
    expect(plugin.syncState.docMap["created1"]).toBeDefined();
    expect(ts).toBe("2026-01-10 00:00:00");
  });
});

describe("sync — orchestration", () => {
  it("calls flushPending before pull", async () => {
    const { engine, fw, apiClient } = buildEngine();
    apiClient.getChanges.mockResolvedValue({ ok: true, data: [], status: 200 });

    const callOrder: string[] = [];
    fw.flushPending.mockImplementation(async () => { callOrder.push("flush"); });
    apiClient.getChanges.mockImplementation(async () => {
      callOrder.push("pull");
      return { ok: true, data: [], status: 200 };
    });

    await engine.sync();

    expect(callOrder[0]).toBe("flush");
    expect(callOrder[1]).toBe("pull");
  });

  it("pull runs before push (verify call order)", async () => {
    const { engine, plugin, apiClient, fm } = buildEngine();
    // Set up a file that would be pushed (dirty hash)
    const file = plugin.app.vault.addFile("Knowledge/dirty.md", "Changed content");
    fm._state.set("Knowledge/dirty.md", { sys_id: "d1", category: "kb_knowledge" });
    plugin.syncState.docMap["d1"] = {
      sysId: "d1", path: "Knowledge/dirty.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash("Original content"), // differs from current file
      lastSyncMtime: 0,
    };

    const callOrder: string[] = [];
    apiClient.getChanges.mockImplementation(async () => {
      callOrder.push("pull");
      return { ok: true, data: [], status: 200 };
    });
    apiClient.updateDocument.mockImplementation(async () => {
      callOrder.push("push");
      return { ok: true, data: { sys_updated_on: "2026-01-03 00:00:00", content_hash: "newhash" }, status: 200 };
    });

    await engine.sync();

    const pullIdx = callOrder.indexOf("pull");
    const pushIdx = callOrder.indexOf("push");
    expect(pullIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(pullIdx).toBeLessThan(pushIdx);
  });

  it("accumulates errors without throwing", async () => {
    const { engine, apiClient } = buildEngine();
    apiClient.getChanges.mockRejectedValue(new Error("Network failure"));

    const result = await engine.sync();

    expect(result.errors.length).toBeGreaterThan(0);
    // Should not throw — errors are caught and accumulated
  });

  it("updates status bar and browser view", async () => {
    const { engine, plugin, apiClient } = buildEngine();
    apiClient.getChanges.mockResolvedValue({ ok: true, data: [], status: 200 });

    await engine.sync();

    expect(plugin.updateStatusBar).toHaveBeenCalledWith("syncing");
    expect(plugin.updateStatusBar).toHaveBeenCalledWith("idle");
    expect(plugin.refreshBrowserView).toHaveBeenCalled();
  });
});

describe("exception safety", () => {
  it("if vault.modify throws during pull, removeSyncWritePath still called", async () => {
    const { engine, plugin, fm, fw } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "Old content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge", synced: true });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };

    plugin.app.vault.modify.mockRejectedValueOnce(new Error("Disk full"));

    const doc = makeDoc({ content: "New remote content" });
    const result = freshResult();

    await expect(callHandlePulledDoc(engine, doc, result)).rejects.toThrow("Disk full");

    expect(fw.addSyncWritePath).toHaveBeenCalledWith("Knowledge/doc.md");
    expect(fw.removeSyncWritePath).toHaveBeenCalledWith("Knowledge/doc.md");
  });

  it("if frontmatterManager.write throws, removeSyncWritePath still called", async () => {
    const { engine, plugin, fm, fw } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "Old content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge", synced: true });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
    };

    fm.write.mockRejectedValueOnce(new Error("FM write failed"));

    const doc = makeDoc({ content: "New remote content" });
    const result = freshResult();

    await expect(callHandlePulledDoc(engine, doc, result)).rejects.toThrow("FM write failed");

    expect(fw.addSyncWritePath).toHaveBeenCalledWith("Knowledge/doc.md");
    expect(fw.removeSyncWritePath).toHaveBeenCalledWith("Knowledge/doc.md");
  });

  it("syncWritePaths tracking: add/remove are always paired", async () => {
    const { engine, plugin, fm, fw, bc } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "Old content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge", synced: true });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash("Old content"),
    };

    const doc = makeDoc({ content: "New remote content" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    // Every addSyncWritePath should have a corresponding removeSyncWritePath
    const addCalls = fw.addSyncWritePath.mock.calls.map((c: any[]) => c[0]);
    const removeCalls = fw.removeSyncWritePath.mock.calls.map((c: any[]) => c[0]);
    expect(addCalls).toEqual(removeCalls);
  });
});

describe("discoverNewDocs", () => {
  it("downloads docs not in docMap", async () => {
    const { engine, plugin, apiClient } = buildEngine();

    const doc1 = makeDoc({ sys_id: "new1", title: "New Doc", category: "kb_knowledge", project: "proj1" });
    apiClient.getDocuments.mockResolvedValue({ ok: true, data: [doc1], status: 200 });

    const result = freshResult();
    await callDiscoverNewDocs(engine, result);

    expect(result.pulled).toBe(1);
    expect(plugin.syncState.docMap["new1"]).toBeDefined();
  });

  it("skips docs already in docMap", async () => {
    const { engine, plugin, apiClient } = buildEngine();
    plugin.syncState.docMap["existing1"] = {
      sysId: "existing1", path: "Knowledge/existing.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "hash",
    };

    const doc1 = makeDoc({ sys_id: "existing1", title: "Existing", category: "kb_knowledge" });
    apiClient.getDocuments.mockResolvedValue({ ok: true, data: [doc1], status: 200 });

    const result = freshResult();
    await callDiscoverNewDocs(engine, result);

    expect(result.pulled).toBe(0);
  });

  it("skips docs in ignoredIds", async () => {
    const { engine, apiClient } = buildEngine({
      stateOverrides: { ignoredIds: ["ignored1"] },
    });

    const doc1 = makeDoc({ sys_id: "ignored1", title: "Ignored", category: "kb_knowledge" });
    apiClient.getDocuments.mockResolvedValue({ ok: true, data: [doc1], status: 200 });

    const result = freshResult();
    await callDiscoverNewDocs(engine, result);

    expect(result.pulled).toBe(0);
  });

  it("handles API failure gracefully", async () => {
    const { engine, apiClient } = buildEngine();
    apiClient.getDocuments.mockResolvedValue({ ok: false, data: null, status: 500 });

    const result = freshResult();
    await callDiscoverNewDocs(engine, result);

    expect(result.pulled).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ==========================================================================
// HASH-BASED SYNC — new tests
// ==========================================================================

describe("hash-based push discovery", () => {
  it("skips file when mtime has not changed", async () => {
    const { engine, plugin, apiClient, fm } = buildEngine();
    const mtime = Date.now() - 10000;
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "Content", makeTFile("Knowledge/doc.md", undefined, mtime));
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "hash1",
      localContentHash: md5Hash("Content"),
      lastSyncMtime: mtime, // same as file mtime
    };

    apiClient.getChanges.mockResolvedValue({ ok: true, data: [], status: 200 });
    const result = await engine.sync();

    expect(apiClient.updateDocument).not.toHaveBeenCalled();
    expect(result.pushed).toBe(0);
  });

  it("skips file when mtime bumped but hash unchanged (cosmetic sn_synced write)", async () => {
    const { engine, plugin, apiClient, fm } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "Content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "hash1",
      localContentHash: md5Hash("Content"),
      lastSyncMtime: 0, // old mtime — will trigger hash check
    };

    apiClient.getChanges.mockResolvedValue({ ok: true, data: [], status: 200 });
    const result = await engine.sync();

    // Hash matches → skip even though mtime bumped
    expect(apiClient.updateDocument).not.toHaveBeenCalled();
    expect(result.pushed).toBe(0);
  });

  it("pushes file when hash changed", async () => {
    const { engine, plugin, apiClient, fm } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/doc.md", "New content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash("Old content"), // differs from current file
      lastSyncMtime: 0,
    };

    apiClient.getChanges.mockResolvedValue({ ok: true, data: [], status: 200 });
    const result = await engine.sync();

    expect(apiClient.updateDocument).toHaveBeenCalled();
    expect(result.pushed).toBe(1);
  });

  it("discovers new files by category without sys_id", async () => {
    const { engine, plugin, apiClient, fm } = buildEngine();
    const file = plugin.app.vault.addFile("Knowledge/new-doc.md", "New doc content");
    fm._state.set("Knowledge/new-doc.md", { category: "kb_knowledge" }); // no sys_id

    apiClient.getChanges.mockResolvedValue({ ok: true, data: [], status: 200 });
    const result = await engine.sync();

    expect(apiClient.createDocument).toHaveBeenCalled();
    expect(result.pushed).toBe(1);
  });

  it("backfills legacy entry when hash matches server hash", async () => {
    const { engine, plugin, apiClient, fm } = buildEngine();
    const content = "Unchanged content";
    const file = plugin.app.vault.addFile("Knowledge/doc.md", content);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00",
      contentHash: md5Hash(content), // server hash matches local hash
      // No localContentHash — legacy entry
    };

    apiClient.getChanges.mockResolvedValue({ ok: true, data: [], status: 200 });
    await engine.sync();

    // Should backfill without pushing
    expect(apiClient.updateDocument).not.toHaveBeenCalled();
    expect(plugin.syncState.docMap["doc1"]!.localContentHash).toBe(md5Hash(content));
    expect(plugin.syncState.docMap["doc1"]!.lastSyncMtime).toBeDefined();
  });
});

describe("pull updates localContentHash and lastSyncMtime", () => {
  it("sets hash fields after overwrite (local clean)", async () => {
    const { engine, plugin, fm } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", "Old content");
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: md5Hash("Old content"),
    };

    const doc = makeDoc({ content: "New server content", content_hash: "newhash" });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    const entry = plugin.syncState.docMap["doc1"]!;
    expect(entry.localContentHash).toBeDefined();
    expect(entry.lastSyncMtime).toBeDefined();
    expect(entry.contentHash).toBe("newhash");
  });

  it("does NOT update hash fields after merge (needs re-push)", async () => {
    const baseContent = "### Section A\n\nOriginal A\n\n### Section B\n\nOriginal B\n";
    const localContent = "### Section A\n\nLocal changed A\n\n### Section B\n\nOriginal B\n";
    const remoteContent = "### Section A\n\nOriginal A\n\n### Section B\n\nRemote changed B\n";

    const { engine, plugin, fm, bc } = buildEngine();
    plugin.app.vault.addFile("Knowledge/doc.md", localContent);
    fm._state.set("Knowledge/doc.md", { sys_id: "doc1", category: "kb_knowledge" });
    const origHash = md5Hash(baseContent);
    plugin.syncState.docMap["doc1"] = {
      sysId: "doc1", path: "Knowledge/doc.md",
      lastServerTimestamp: "2026-01-01 00:00:00", contentHash: "oldhash",
      localContentHash: origHash,
    };
    bc._store.set("doc1", baseContent);

    const doc = makeDoc({ content: remoteContent });
    const result = freshResult();
    await callHandlePulledDoc(engine, doc, result);

    const entry = plugin.syncState.docMap["doc1"]!;
    // localContentHash should NOT have been updated — still the old value
    expect(entry.localContentHash).toBe(origHash);
  });
});
