import { Notice, TFile } from "obsidian";
import type SNSyncPlugin from "./main";
import type { ConflictEntry, SectionConflict } from "./types";
import type { BaseCache } from "./base-cache";
import { stripFrontmatter, replaceBody } from "./frontmatter-format";
import { parseSections, serializeSections } from "./section-parser";
import { mergeSections } from "./section-merger";
import { computeDiff, computeSideBySide, assembleDiffWithLineChoices, type DiffLine, type SideBySideLine } from "./diff";

/** One conflicting section prepared for interactive rendering — the diff the view renders is the diff apply will interpret. */
export interface PreparedSection {
  key: string;
  heading: string;
  diffLines: DiffLine[];
  sideBySide: SideBySideLine[];
}

export interface PreparedLineDiff {
  path: string;
  sections: PreparedSection[];
}
import { contentHash, md5Hash } from "./content-hash";
import { computeLocalHash } from "./sync-engine";

const MARKER_LOCAL = "<<<<<<< Local (Obsidian)";
const MARKER_SEPARATOR = "=======";
const MARKER_REMOTE = ">>>>>>> Remote (ServiceNow)";

export function hasConflictMarkers(content: string): boolean {
  return content.includes(MARKER_LOCAL) && content.includes(MARKER_REMOTE);
}

export function stripConflictMarkers(content: string): string {
  const startIdx = content.indexOf(MARKER_LOCAL);
  if (startIdx === -1) return content;

  const endIdx = content.indexOf(MARKER_REMOTE, startIdx);
  if (endIdx === -1) return content;

  // Find the separator between the local and remote markers (not an unrelated one)
  const blockContent = content.substring(startIdx, endIdx);
  const sepRelative = blockContent.lastIndexOf(MARKER_SEPARATOR);
  if (sepRelative === -1) return content;
  const sepIdx = startIdx + sepRelative;

  const localPortion = content.substring(startIdx + MARKER_LOCAL.length + 1, sepIdx);
  // Strip exactly one trailing/leading newline at the boundaries (not all whitespace)
  const before = content.substring(0, startIdx).replace(/\n$/, "");
  const after = content.substring(endIdx + MARKER_REMOTE.length).replace(/^\n/, "");

  return [before, localPortion.replace(/\n$/, ""), after].filter((s) => s.length > 0).join("\n");
}

/**
 * Assemble a merged document body from per-section user choices.
 * Runs mergeSections() to auto-resolve non-conflicting sections,
 * then substitutes user choices for conflicting ones.
 */
export function assemblePerSectionMerge(
  localBody: string,
  remoteBody: string,
  baseBody: string | null,
  choices: Map<string, "local" | "remote">,
): string {
  const baseSections = baseBody ? parseSections(baseBody) : null;
  const localSections = parseSections(localBody);
  const remoteSections = parseSections(remoteBody);
  const mergeResult = mergeSections(baseSections, localSections, remoteSections);

  // Start with the auto-merged result parsed back into sections
  const mergedSections = parseSections(mergeResult.mergedBody);
  const final = new Map(mergedSections);

  // Override conflicting sections with user choices
  for (const conflict of mergeResult.conflicts) {
    const choice = choices.get(conflict.key);
    if (!choice) continue;
    const source = choice === "local" ? localSections : remoteSections;
    const section = source.get(conflict.key);
    if (section) {
      final.set(conflict.key, section);
    }
  }

  return serializeSections(final);
}

/**
 * Assemble a merged body using per-line choices, diffing each conflicting
 * section against the **stored** conflict bodies (what the user was shown),
 * not a fresh re-diff of the current file. Non-conflicting sections still
 * auto-merge from the current file/remote. This keeps the applied index space
 * identical to the one the drill-in rendered (see prepareLineDiff).
 */
export function assembleWithStoredLineChoices(
  localBody: string,
  remoteBody: string,
  baseBody: string | null,
  storedConflicts: SectionConflict[],
  lineChoices: Map<string, Map<number, boolean>>,
): string {
  const baseSections = baseBody ? parseSections(baseBody) : null;
  const mergeResult = mergeSections(baseSections, parseSections(localBody), parseSections(remoteBody));
  const final = new Map(parseSections(mergeResult.mergedBody));

  for (const sc of storedConflicts) {
    const choices = lineChoices.get(sc.key);
    const body =
      choices && choices.size > 0
        ? assembleDiffWithLineChoices(computeDiff(sc.localBody, sc.remoteBody), choices)
        : sc.localBody;
    final.set(sc.key, { heading: sc.heading, key: sc.key, body, hash: contentHash(body) });
  }

  return serializeSections(final);
}

export class ConflictResolver {
  private plugin: SNSyncPlugin;
  private baseCache: BaseCache;

  constructor(plugin: SNSyncPlugin, baseCache: BaseCache) {
    this.plugin = plugin;
    this.baseCache = baseCache;
  }

  applyConflict(entry: ConflictEntry) {
    this.plugin.syncState.conflicts[entry.sysId] = entry;
  }

  /**
   * A resolution incorporates the server version it was shown, so that version
   * becomes the push baseline. Without this the next push keeps sending the
   * pre-conflict hash, the server 409s against the same ancestor, and the very
   * same conflict is raised again on every sync.
   */
  private adoptRemoteBaseline(conflict: ConflictEntry) {
    const entry = this.plugin.syncState.docMap[conflict.sysId];
    if (!entry) return;
    // Conflicts recorded before the hash was carried have none stored; the server
    // hash is md5 of the same normalized content, so recompute it from the body.
    entry.contentHash = conflict.remoteContentHash ?? md5Hash(conflict.remoteContent);
    entry.lastServerTimestamp = conflict.remoteTimestamp;
  }

  async resolveWithPull(sysId: string) {
    const conflict = this.plugin.syncState.conflicts[sysId];
    if (!conflict) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
    if (!(file instanceof TFile)) {
      delete this.plugin.syncState.conflicts[sysId];
      await this.plugin.saveSettings();
      return;
    }

    const fm = this.plugin.frontmatterManager.read(file);
    await this.plugin.fileWatcher.duringSyncWrite(conflict.path, async () => {
      await this.plugin.app.vault.modify(file, conflict.remoteContent);
      await this.plugin.frontmatterManager.write(file, {
        sys_id: fm.sys_id ?? sysId,
        category: fm.category,
        project: fm.project,
        tags: fm.tags,
        synced: true,
      });
    });

    this.adoptRemoteBaseline(conflict);

    const entry = this.plugin.syncState.docMap[sysId];
    if (entry) {
      entry.lastServerTimestamp = conflict.remoteTimestamp;
      entry.localContentHash = await computeLocalHash(
        this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
      );
      entry.lastSyncMtime = file.stat.mtime;
    }

    await this.baseCache.saveBase(sysId, stripFrontmatter(conflict.remoteContent));

    delete this.plugin.syncState.conflicts[sysId];
    await this.plugin.saveSettings();

    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    new Notice(`"${fileName}" updated with remote content.`);
  }

  async resolveWithPush(sysId: string) {
    const conflict = this.plugin.syncState.conflicts[sysId];
    if (!conflict) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
    if (file instanceof TFile) {
      await this.plugin.frontmatterManager.markDirty(file);
    }

    this.adoptRemoteBaseline(conflict);
    this.plugin.syncEngine.addSkipPullId(sysId);
    delete this.plugin.syncState.conflicts[sysId];
    await this.plugin.saveSettings();

    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    new Notice(`"${fileName}" will push local content on next sync.`);
  }

  async resolvePerSection(sysId: string, choices: Map<string, "local" | "remote">): Promise<void> {
    const conflict = this.plugin.syncState.conflicts[sysId];
    if (!conflict) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
    if (!(file instanceof TFile)) {
      delete this.plugin.syncState.conflicts[sysId];
      await this.plugin.saveSettings();
      return;
    }

    const raw = await this.plugin.app.vault.read(file);
    const localBody = stripFrontmatter(raw);
    const remoteBody = stripFrontmatter(conflict.remoteContent);
    const baseBody = conflict.ancestorContent
      ? stripFrontmatter(conflict.ancestorContent)
      : await this.baseCache.loadBase(sysId);

    const mergedBody = assemblePerSectionMerge(localBody, remoteBody, baseBody, choices);

    // Rebuild file with existing frontmatter + merged body
    const newContent = replaceBody(raw, mergedBody);

    await this.plugin.fileWatcher.duringSyncWrite(conflict.path, async () => {
      await this.plugin.app.vault.modify(file, newContent);
      await this.plugin.frontmatterManager.markDirty(file);
    });

    await this.baseCache.saveBase(sysId, mergedBody);

    this.adoptRemoteBaseline(conflict);
    this.plugin.syncEngine.addSkipPullId(sysId);
    delete this.plugin.syncState.conflicts[sysId];
    await this.plugin.saveSettings();

    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    new Notice(`"${fileName}" merged with per-section choices.`);
  }

  async resolveWithLineChoices(
    sysId: string,
    lineChoices: Map<string, Map<number, boolean>>,
  ): Promise<void> {
    const conflict = this.plugin.syncState.conflicts[sysId];
    if (!conflict) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
    if (!(file instanceof TFile)) {
      delete this.plugin.syncState.conflicts[sysId];
      await this.plugin.saveSettings();
      return;
    }

    const raw = await this.plugin.app.vault.read(file);
    const localBody = stripFrontmatter(raw);
    const remoteBody = stripFrontmatter(conflict.remoteContent);
    const baseBody = conflict.ancestorContent
      ? stripFrontmatter(conflict.ancestorContent)
      : await this.baseCache.loadBase(sysId);

    const mergedBody = assembleWithStoredLineChoices(
      localBody, remoteBody, baseBody, conflict.sectionConflicts ?? [], lineChoices,
    );

    const newContent = replaceBody(raw, mergedBody);

    await this.plugin.fileWatcher.duringSyncWrite(conflict.path, async () => {
      await this.plugin.app.vault.modify(file, newContent);
      await this.plugin.frontmatterManager.markDirty(file);
    });

    await this.baseCache.saveBase(sysId, mergedBody);

    this.adoptRemoteBaseline(conflict);
    this.plugin.syncEngine.addSkipPullId(sysId);
    delete this.plugin.syncState.conflicts[sysId];
    await this.plugin.saveSettings();

    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    new Notice(`"${fileName}" merged with per-line choices.`);
  }

  /**
   * The per-section diffs for a conflict's drill-in view, computed once from the
   * stored conflict bodies. The view renders exactly these; resolveWithLineChoices
   * interprets choices against the same (stored) diff, so their indices can't drift.
   */
  prepareLineDiff(sysId: string): PreparedLineDiff | null {
    const conflict = this.plugin.syncState.conflicts[sysId];
    if (!conflict) return null;
    const sections: PreparedSection[] = (conflict.sectionConflicts ?? []).map((s) => ({
      key: s.key,
      heading: s.heading,
      diffLines: computeDiff(s.localBody, s.remoteBody),
      sideBySide: computeSideBySide(s.localBody, s.remoteBody),
    }));
    return { path: conflict.path, sections };
  }

  getConflictForPath(path: string): ConflictEntry | null {
    for (const conflict of Object.values(this.plugin.syncState.conflicts)) {
      if (conflict.path === path) return conflict;
    }
    return null;
  }

  getAllConflicts(): ConflictEntry[] {
    return Object.values(this.plugin.syncState.conflicts);
  }

  async clearStaleConflicts(): Promise<number> {
    let cleared = 0;

    for (const [sysId, conflict] of Object.entries(this.plugin.syncState.conflicts)) {
      const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
      if (!(file instanceof TFile)) {
        delete this.plugin.syncState.conflicts[sysId];
        cleared++;
        continue;
      }

      const raw = await this.plugin.app.vault.read(file);
      const localBody = stripFrontmatter(raw);
      const remoteBody = stripFrontmatter(conflict.remoteContent);
      if (localBody === remoteBody) {
        delete this.plugin.syncState.conflicts[sysId];
        await this.plugin.fileWatcher.duringSyncWrite(conflict.path, () =>
          this.plugin.frontmatterManager.markSynced(file),
        );
        cleared++;
      }
    }

    if (cleared > 0) {
      await this.plugin.saveSettings();
    }
    return cleared;
  }

  /** Drop a single conflict without resolving it (the view's per-row "Dismiss"). */
  async dismissConflict(sysId: string): Promise<void> {
    if (!this.plugin.syncState.conflicts[sysId]) return;
    delete this.plugin.syncState.conflicts[sysId];
    await this.plugin.saveSettings();
  }

  async clearAllConflicts(): Promise<number> {
    const count = Object.keys(this.plugin.syncState.conflicts).length;
    if (count === 0) return 0;

    this.plugin.syncState.conflicts = {};
    await this.plugin.saveSettings();
    return count;
  }

  async migrateMarkerFiles() {
    const trackedPaths = new Set(
      Object.values(this.plugin.syncState.docMap).map((e) => e.path)
    );
    if (trackedPaths.size === 0) return;

    const files = this.plugin.app.vault.getMarkdownFiles().filter(
      (f) => trackedPaths.has(f.path)
    );
    let migrated = 0;

    for (const file of files) {
      const content = await this.plugin.app.vault.read(file);
      if (!hasConflictMarkers(content)) continue;

      const cleaned = stripConflictMarkers(content);
      await this.plugin.fileWatcher.duringSyncWrite(file.path, () =>
        this.plugin.app.vault.modify(file, cleaned),
      );
      migrated++;
    }

    if (migrated > 0) {
      new Notice(`Migrated ${migrated} file${migrated > 1 ? "s" : ""} from old conflict format.`);
    }
  }
}
