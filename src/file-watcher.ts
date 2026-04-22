import { TFile } from "obsidian";
import type SNSyncPlugin from "./main";
import type { FrontmatterManager } from "./frontmatter-manager";
import type { ApiClient } from "./api-client";

const DEBOUNCE_MS = 500;

export class FileWatcher {
  private plugin: SNSyncPlugin;
  private frontmatterManager: FrontmatterManager;
  private apiClient: ApiClient;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private syncWritePaths: Set<string> = new Set();

  constructor(plugin: SNSyncPlugin, frontmatterManager: FrontmatterManager, apiClient: ApiClient) {
    this.plugin = plugin;
    this.frontmatterManager = frontmatterManager;
    this.apiClient = apiClient;
  }

  start() {
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.onModify(file);
      })
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => {
        if (file instanceof TFile) void this.onDelete(file);
      })
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) void this.onRename(file, oldPath);
      })
    );
  }

  addSyncWritePath(path: string) {
    this.syncWritePaths.add(path);
  }

  removeSyncWritePath(path: string) {
    this.syncWritePaths.delete(path);
  }

  private isSyncedFile(path: string): boolean {
    if (!path.endsWith(".md")) return false;
    return !this.isExcluded(path);
  }

  isExcluded(path: string): boolean {
    for (const pattern of this.plugin.settings.excludePaths) {
      if (path.startsWith(pattern) || path === pattern) return true;
      if (pattern.startsWith("*") && path.endsWith(pattern.slice(1))) return true;
    }
    return false;
  }

  private onModify(file: TFile) {
    if (!this.isSyncedFile(file.path)) return;
    if (this.syncWritePaths.has(file.path)) return;

    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      file.path,
      setTimeout(() => {
        this.debounceTimers.delete(file.path);
        void this.handleFileModified(file);
      }, DEBOUNCE_MS)
    );
  }

  private async handleFileModified(file: TFile) {
    const fm = this.frontmatterManager.read(file);
    // Cosmetic: flip sn_synced to false so the user sees it's modified
    if (fm.sys_id && fm.synced !== false) {
      this.syncWritePaths.add(file.path);
      try {
        await this.frontmatterManager.markDirty(file);
      } finally {
        this.syncWritePaths.delete(file.path);
      }
    }
  }

  private async onDelete(file: TFile) {
    if (!this.isSyncedFile(file.path)) return;

    const entry = Object.values(this.plugin.syncState.docMap).find(
      (e) => e.path === file.path
    );
    if (!entry) return;

    const behavior = this.plugin.settings.localDeleteBehavior;

    switch (behavior) {
      case "ignore":
        if (!this.plugin.syncState.ignoredIds.includes(entry.sysId)) {
          this.plugin.syncState.ignoredIds.push(entry.sysId);
        }
        delete this.plugin.syncState.docMap[entry.sysId];
        await this.plugin.saveSettings();
        break;
      case "re-pull":
        break;
      case "archive": {
        if (!this.plugin.syncState.ignoredIds.includes(entry.sysId)) {
          this.plugin.syncState.ignoredIds.push(entry.sysId);
        }
        delete this.plugin.syncState.docMap[entry.sysId];
        await this.plugin.saveSettings();
        break;
      }
    }
  }

  private async onRename(file: TFile, oldPath: string) {
    if (!this.isSyncedFile(file.path) && !this.isSyncedFile(oldPath)) return;

    const entry = Object.values(this.plugin.syncState.docMap).find(
      (e) => e.path === oldPath
    );
    if (entry) {
      entry.path = file.path;
      await this.plugin.saveSettings();
    }
  }

  async flushPending(): Promise<void> {
    const pending = Array.from(this.debounceTimers.entries());
    for (const [path, timer] of pending) {
      clearTimeout(timer);
      this.debounceTimers.delete(path);
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.handleFileModified(file);
      }
    }
  }
}
