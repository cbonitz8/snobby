import { describe, it, expect, vi } from "vitest";
import { TFile } from "obsidian";
import {
  ConflictResolver,
  hasConflictMarkers,
  stripConflictMarkers,
  assemblePerSectionMerge,
  assembleWithStoredLineChoices,
} from "./conflict-resolver";
import { computeDiff } from "./diff";
import { md5Hash } from "./content-hash";
import type { ConflictEntry, SectionConflict } from "./types";

describe("hasConflictMarkers", () => {
  it("detects conflict markers", () => {
    const content = "some text\n<<<<<<< Local (Obsidian)\nfoo\n=======\nbar\n>>>>>>> Remote (ServiceNow)\nmore text";
    expect(hasConflictMarkers(content)).toBe(true);
  });

  it("returns false for clean content", () => {
    expect(hasConflictMarkers("just normal text")).toBe(false);
  });
});

describe("stripConflictMarkers", () => {
  it("extracts local portion from conflicted content", () => {
    const conflicted = "<<<<<<< Local (Obsidian)\nmy local text\n=======\nremote text\n>>>>>>> Remote (ServiceNow)";
    expect(stripConflictMarkers(conflicted)).toBe("my local text");
  });

  it("preserves surrounding content", () => {
    const conflicted = "before\n<<<<<<< Local (Obsidian)\nlocal\n=======\nremote\n>>>>>>> Remote (ServiceNow)\nafter";
    expect(stripConflictMarkers(conflicted)).toBe("before\nlocal\nafter");
  });

  it("returns content unchanged if no markers present", () => {
    expect(stripConflictMarkers("just normal text")).toBe("just normal text");
  });

  it("strips outermost markers from nested content", () => {
    const nested = "<<<<<<< Local (Obsidian)\n<<<<<<< Local (Obsidian)\ninner\n=======\ninner remote\n>>>>>>> Remote (ServiceNow)\n=======\nouter remote\n>>>>>>> Remote (ServiceNow)";
    const result = stripConflictMarkers(nested);
    const secondPass = stripConflictMarkers(result);
    expect(hasConflictMarkers(secondPass)).toBe(false);
  });
});

describe("assemblePerSectionMerge", () => {
  it("assembles merged doc from auto-resolved and user choices", () => {
    const localBody = "preamble\n\n### caleb\n\nlocal caleb content\n\n### jordan\n\njordan shared content\n";
    const remoteBody = "preamble\n\n### caleb\n\nremote caleb content\n\n### jordan\n\njordan shared content\n";
    const baseBody = "preamble\n\n### caleb\n\nold caleb content\n\n### jordan\n\njordan shared content\n";
    const choices = new Map<string, "local" | "remote">([["caleb", "remote"]]);

    const result = assemblePerSectionMerge(localBody, remoteBody, baseBody, choices);
    expect(result).toContain("remote caleb content");
    expect(result).toContain("jordan shared content");
    expect(result).not.toContain("local caleb content");
  });

  it("keeps local section when user chooses local", () => {
    const localBody = "### caleb\n\nmy local stuff\n";
    const remoteBody = "### caleb\n\nremote stuff\n";
    const baseBody = "### caleb\n\nold stuff\n";
    const choices = new Map<string, "local" | "remote">([["caleb", "local"]]);

    const result = assemblePerSectionMerge(localBody, remoteBody, baseBody, choices);
    expect(result).toContain("my local stuff");
    expect(result).not.toContain("remote stuff");
  });

  it("auto-merges non-conflicting sections without requiring a choice", () => {
    const baseBody = "### caleb\n\nold\n\n### jordan\n\nold jordan\n";
    const localBody = "### caleb\n\nlocal caleb\n\n### jordan\n\nold jordan\n";
    const remoteBody = "### caleb\n\nremote caleb\n\n### jordan\n\nnew jordan\n";
    const choices = new Map<string, "local" | "remote">([["caleb", "local"]]);

    const result = assemblePerSectionMerge(localBody, remoteBody, baseBody, choices);
    expect(result).toContain("local caleb");
    expect(result).toContain("new jordan");
  });

  it("handles null base (two-way merge)", () => {
    const localBody = "### caleb\n\nlocal\n";
    const remoteBody = "### caleb\n\nremote\n";
    const choices = new Map<string, "local" | "remote">([["caleb", "remote"]]);

    const result = assemblePerSectionMerge(localBody, remoteBody, null, choices);
    expect(result).toContain("remote");
  });
});

describe("assembleWithStoredLineChoices", () => {
  // Current file's conflicting section differs from what was shown at detection.
  const localBody = "### a\ncurrent-a\n### b\nB1";
  const remoteBody = "### a\nremote-a\n### b\nB1";
  const stored: SectionConflict[] = [
    { key: "a", heading: "### a", localBody: "alpha", remoteBody: "beta", baseBody: null },
  ];

  it("applies line choices against the STORED bodies, not the current file", () => {
    // choose the local ("alpha") side of the stored diff, drop the added ("beta") side
    const diff = computeDiff("alpha", "beta");
    const choices = new Map<number, boolean>();
    diff.forEach((l, i) => {
      if (l.type === "removed") choices.set(i, true);
      else if (l.type === "added") choices.set(i, false);
    });
    const lineChoices = new Map([["a", choices]]);

    const out = assembleWithStoredLineChoices(localBody, remoteBody, null, stored, lineChoices);
    expect(out).toContain("alpha"); // from the stored diff
    expect(out).not.toContain("beta"); // excluded
    expect(out).not.toContain("current-a"); // current-file body was overridden
  });

  it("keeps the non-conflicting section merged from the current file/remote", () => {
    const out = assembleWithStoredLineChoices(localBody, remoteBody, null, stored, new Map());
    expect(out).toContain("### b\nB1");
  });

  it("falls back to the stored local body when a section has no line choices", () => {
    const out = assembleWithStoredLineChoices(localBody, remoteBody, null, stored, new Map());
    expect(out).toContain("alpha");
  });
});

// ---------------------------------------------------------------------------
// ConflictResolver — baseline hand-off after a resolution
// ---------------------------------------------------------------------------

function makeResolverHarness(fileBody: string) {
  const files = new Map<string, { path: string; content: string }>();
  const file = Object.assign(new TFile(), { path: "Knowledge/doc.md", basename: "doc" });
  files.set(file.path, { path: file.path, content: fileBody });

  const baseStore = new Map<string, string>();
  const baseCache = {
    loadBase: vi.fn(async (sysId: string) => baseStore.get(sysId) ?? null),
    saveBase: vi.fn(async (sysId: string, body: string) => { baseStore.set(sysId, body); }),
    removeBase: vi.fn(async (sysId: string) => { baseStore.delete(sysId); }),
  };

  const plugin = {
    settings: { frontmatterPrefix: "sn_" },
    syncState: {
      conflicts: {} as Record<string, ConflictEntry>,
      docMap: {
        doc1: {
          sysId: "doc1",
          path: file.path,
          lastServerTimestamp: "2026-01-01 00:00:00",
          contentHash: "stalehash",
          localContentHash: "localhash",
          lastSyncMtime: 0,
        },
      },
    },
    app: {
      vault: {
        getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
        read: async () => files.get(file.path)!.content,
        modify: vi.fn(async (_f: unknown, content: string) => {
          files.get(file.path)!.content = content;
        }),
      },
    },
    frontmatterManager: {
      read: vi.fn(() => ({ sys_id: "doc1", category: "kb", project: "", tags: "" })),
      write: vi.fn(async () => {}),
      markDirty: vi.fn(async () => {}),
      markSynced: vi.fn(async () => {}),
    },
    fileWatcher: {
      duringSyncWrite: vi.fn(async (_p: string, fn: () => Promise<void> | void) => { await fn(); }),
    },
    syncEngine: { addSkipPullId: vi.fn() },
    saveSettings: vi.fn(async () => {}),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolver = new ConflictResolver(plugin as any, baseCache as any);
  return { plugin, resolver, file, baseCache };
}

const REMOTE_BODY = "### Section A\n\nRemote changed content\n";
const LOCAL_BODY = "### Section A\n\nLocal changed content\n";

function seedConflict(plugin: ReturnType<typeof makeResolverHarness>["plugin"]) {
  plugin.syncState.conflicts["doc1"] = {
    sysId: "doc1",
    path: "Knowledge/doc.md",
    remoteContent: REMOTE_BODY,
    remoteTimestamp: "2026-01-05 00:00:00",
    remoteContentHash: "serverhash",
    ancestorContent: "### Section A\n\nOriginal content\n",
    sectionConflicts: [],
  };
}

describe("ConflictResolver — adopts the resolved-against server hash", () => {
  it("resolveWithPull records the server hash as the new push baseline", async () => {
    const { plugin, resolver } = makeResolverHarness(LOCAL_BODY);
    seedConflict(plugin);

    await resolver.resolveWithPull("doc1");

    expect(plugin.syncState.docMap["doc1"].contentHash).toBe("serverhash");
  });

  it("resolveWithPush records the server hash so the next push is accepted", async () => {
    const { plugin, resolver } = makeResolverHarness(LOCAL_BODY);
    seedConflict(plugin);

    await resolver.resolveWithPush("doc1");

    expect(plugin.syncState.docMap["doc1"].contentHash).toBe("serverhash");
  });

  it("resolvePerSection records the server hash so the merge can land", async () => {
    const { plugin, resolver } = makeResolverHarness(LOCAL_BODY);
    seedConflict(plugin);

    await resolver.resolvePerSection("doc1", new Map([["section-a", "local"]]));

    expect(plugin.syncState.docMap["doc1"].contentHash).toBe("serverhash");
  });

  it("resolveWithLineChoices records the server hash so the merge can land", async () => {
    const { plugin, resolver } = makeResolverHarness(LOCAL_BODY);
    seedConflict(plugin);

    await resolver.resolveWithLineChoices("doc1", new Map());

    expect(plugin.syncState.docMap["doc1"].contentHash).toBe("serverhash");
  });

  it("legacy conflict with no stored hash: recomputes the server hash from the remote body", async () => {
    const { plugin, resolver } = makeResolverHarness(LOCAL_BODY);
    seedConflict(plugin);
    delete plugin.syncState.conflicts["doc1"]!.remoteContentHash;

    await resolver.resolveWithPush("doc1");

    expect(plugin.syncState.docMap["doc1"].contentHash).toBe(md5Hash(REMOTE_BODY));
  });

  it("dismissConflict leaves the stale hash — dismissal is not a resolution", async () => {
    const { plugin, resolver } = makeResolverHarness(LOCAL_BODY);
    seedConflict(plugin);

    await resolver.dismissConflict("doc1");

    expect(plugin.syncState.docMap["doc1"].contentHash).toBe("stalehash");
  });
});
