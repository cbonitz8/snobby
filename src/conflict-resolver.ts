import { Notice, TFile } from "obsidian";
import type SNSyncPlugin from "./main";
import type { ConflictEntry } from "./types";
import type { BaseCache } from "./base-cache";
import { ConflictModal } from "./conflict-modal";
import { stripFrontmatter } from "./frontmatter-manager";
import { parseSections, serializeSections } from "./section-parser";
import { mergeSections } from "./section-merger";

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

export class ConflictResolver {
  private plugin: SNSyncPlugin;
  private baseCache: BaseCache;

  constructor(plugin: SNSyncPlugin, baseCache: BaseCache) {
    this.plugin = plugin;
    this.baseCache = baseCache;
  }

  applyConflict(entry: ConflictEntry) {
    this.plugin.syncState.conflicts[entry.sysId] = entry;
    new ConflictModal(this.plugin, entry).open();
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
    this.plugin.fileWatcher.addSyncWritePath(conflict.path);
    await this.plugin.app.vault.modify(file, conflict.remoteContent);
    await this.plugin.frontmatterManager.write(file, {
      sys_id: fm.sys_id ?? sysId,
      category: fm.category,
      project: fm.project,
      tags: fm.tags,
      synced: true,
    });
    this.plugin.fileWatcher.removeSyncWritePath(conflict.path);

    try {
      await this.plugin.apiClient.checkin(sysId);
    } catch {
      // best-effort — lock may not have been held
    }

    const entry = this.plugin.syncState.docMap[sysId];
    if (entry) {
      entry.lastServerTimestamp = conflict.remoteTimestamp;
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

    if (conflict.lockedBy) {
      const username = this.plugin.settings.username;
      if (!username || conflict.lockedBy !== username) {
        new Notice(`Cannot push — file is locked by ${conflict.lockedBy}. Pull remote or coordinate with them.`);
        return;
      }
    }

    const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
    if (file instanceof TFile) {
      const raw = await this.plugin.app.vault.read(file);
      await this.baseCache.saveBase(sysId, stripFrontmatter(raw));
      await this.plugin.frontmatterManager.markDirty(file);
    }

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
    const baseBody = await this.baseCache.loadBase(sysId);

    const mergedBody = assemblePerSectionMerge(localBody, remoteBody, baseBody, choices);

    // Rebuild file with existing frontmatter + merged body
    let newContent: string;
    if (raw.startsWith("---")) {
      const endIdx = raw.indexOf("\n---", 3);
      if (endIdx !== -1) {
        newContent = raw.substring(0, endIdx + 4) + "\n" + mergedBody;
      } else {
        newContent = mergedBody;
      }
    } else {
      newContent = mergedBody;
    }

    this.plugin.fileWatcher.addSyncWritePath(conflict.path);
    await this.plugin.app.vault.modify(file, newContent);
    await this.plugin.frontmatterManager.markDirty(file);
    this.plugin.fileWatcher.removeSyncWritePath(conflict.path);

    await this.baseCache.saveBase(sysId, mergedBody);

    delete this.plugin.syncState.conflicts[sysId];
    await this.plugin.saveSettings();

    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    new Notice(`"${fileName}" merged with per-section choices.`);
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
        this.plugin.fileWatcher.addSyncWritePath(conflict.path);
        await this.plugin.frontmatterManager.markSynced(file);
        this.plugin.fileWatcher.removeSyncWritePath(conflict.path);
        cleared++;
      }
    }

    if (cleared > 0) {
      await this.plugin.saveSettings();
    }
    return cleared;
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
      this.plugin.fileWatcher.addSyncWritePath(file.path);
      await this.plugin.app.vault.modify(file, cleaned);
      this.plugin.fileWatcher.removeSyncWritePath(file.path);
      migrated++;
    }

    if (migrated > 0) {
      new Notice(`Migrated ${migrated} file${migrated > 1 ? "s" : ""} from old conflict format.`);
    }
  }
}
