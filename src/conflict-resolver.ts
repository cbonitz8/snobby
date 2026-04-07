import { Notice, TFile } from "obsidian";
import type SNSyncPlugin from "./main";
import type { ConflictEntry } from "./types";

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

export class ConflictResolver {
  private plugin: SNSyncPlugin;

  constructor(plugin: SNSyncPlugin) {
    this.plugin = plugin;
  }

  applyConflict(sysId: string, path: string, remoteContent: string, remoteTimestamp: string, lockedBy: string) {
    this.plugin.syncState.conflicts[sysId] = {
      sysId,
      path,
      remoteContent,
      remoteTimestamp,
      lockedBy,
    };

    const fileName = path.split("/").pop() ?? path;
    if (lockedBy) {
      new Notice(`"${fileName}" has remote changes by ${lockedBy} (file is locked). Use "Resolve conflict: pull remote" to update.`);
    } else {
      new Notice(`"${fileName}" has remote changes. Use command palette to resolve: pull remote or push local.`);
    }
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
      await this.plugin.frontmatterManager.markDirty(file);
    }

    delete this.plugin.syncState.conflicts[sysId];
    await this.plugin.saveSettings();

    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    new Notice(`"${fileName}" will push local content on next sync.`);
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
      const localBody = this.stripFrontmatter(raw);
      const remoteBody = this.stripFrontmatter(conflict.remoteContent);
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

  stripFrontmatter(raw: string): string {
    if (!raw.startsWith("---")) return raw;
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx === -1) return raw;
    return raw.slice(endIdx + 4).replace(/^\n+/, "");
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
