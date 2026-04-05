import { TFile, Notice, normalizePath } from "obsidian";
import type SNSyncPlugin from "./main";
import type { ApiClient } from "./api-client";
import type { FrontmatterManager } from "./frontmatter-manager";
import type { FileWatcher } from "./file-watcher";
import type { ConflictResolver } from "./conflict-resolver";
import type { SNDocument, SNMetadata, SyncResult } from "./types";
import { resolveFilePath } from "./folder-mapper";
import { promptNewDocMetadata } from "./new-doc-modal";

export class SyncEngine {
  private plugin: SNSyncPlugin;
  private apiClient: ApiClient;
  private frontmatterManager: FrontmatterManager;
  private fileWatcher: FileWatcher;
  private conflictResolver: ConflictResolver;
  private intervalId: number | null = null;
  private isSyncing = false;
  private cachedMetadata: SNMetadata | null = null;

  constructor(
    plugin: SNSyncPlugin,
    apiClient: ApiClient,
    frontmatterManager: FrontmatterManager,
    fileWatcher: FileWatcher,
    conflictResolver: ConflictResolver
  ) {
    this.plugin = plugin;
    this.apiClient = apiClient;
    this.frontmatterManager = frontmatterManager;
    this.fileWatcher = fileWatcher;
    this.conflictResolver = conflictResolver;
  }

  start() {
    if (this.plugin.settings.syncMode === "interval") {
      this.startInterval();
    }
  }

  stop() {
    this.stopInterval();
  }

  restart() {
    this.stop();
    this.start();
  }

  private startInterval() {
    this.stopInterval();
    const ms = this.plugin.settings.syncIntervalSeconds * 1000;
    this.intervalId = window.setInterval(() => this.sync(), ms);
    this.plugin.registerInterval(this.intervalId);
  }

  private stopInterval() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async sync(): Promise<SyncResult> {
    if (this.isSyncing) return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
    this.isSyncing = true;
    this.plugin.updateStatusBar("syncing");

    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };

    try {
      await this.pull(result);
      await this.warnLockedDirtyFiles();
      await this.push(result);
      this.plugin.syncState.lastSyncTimestamp = new Date().toISOString();
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
      console.error("Snobby: Sync cycle error", e);
    }

    this.isSyncing = false;
    if (result.errors.length > 0) {
      console.error("Snobby: Sync errors:", result.errors);
      new Notice(`Snobby errors:\n${result.errors.join("\n")}`);
    }
    this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    return result;
  }

  async initialPull(): Promise<SyncResult> {
    if (this.isSyncing) return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
    this.isSyncing = true;
    this.plugin.updateStatusBar("syncing");

    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };

    try {
      const response = await this.apiClient.getDocuments();
      if (!response.ok || !response.data) {
        result.errors.push(`Initial pull failed: HTTP ${response.status}`);
        return result;
      }

      const docs = Array.isArray(response.data) ? response.data : [response.data];
      for (const doc of docs) {
        try {
          await this.createLocalFile(doc);
          result.pulled++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Failed to create ${doc.title}: ${msg}`);
        }
      }

      this.plugin.syncState.lastSyncTimestamp = new Date().toISOString();
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
    } finally {
      this.isSyncing = false;
      if (result.errors.length > 0) {
        console.error("Snobby: Initial pull errors:", result.errors);
        new Notice(`Snobby errors:\n${result.errors.join("\n")}`);
      }
      this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    }
    return result;
  }

  async bulkPush(): Promise<SyncResult> {
    if (this.isSyncing) return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
    this.isSyncing = true;
    this.plugin.updateStatusBar("syncing");

    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };

    try {
      const allFiles = this.plugin.app.vault.getMarkdownFiles();
      const candidates: TFile[] = [];

      for (const file of allFiles) {
        const fm = await this.frontmatterManager.read(file);
        if (fm.category && !fm.sys_id) {
          candidates.push(file);
        }
      }

      const total = candidates.length;
      new Notice(`Bulk push: ${total} documents to upload`);
      console.log(`Snobby: Bulk push starting — ${total} files`);

      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        try {
          const fm = await this.frontmatterManager.read(file);
          const content = await this.getFileContent(file);

          const createResult = await this.apiClient.createDocument({
            title: file.basename,
            content,
            category: fm.category ?? "",
            project: fm.project ?? "",
            tags: fm.tags ?? "",
          });

          if (!createResult.ok || !createResult.data) {
            result.errors.push(`Failed: ${file.basename} (HTTP ${createResult.status})`);
            continue;
          }

          const newDoc = createResult.data;

          this.fileWatcher.addSyncWritePath(file.path);
          await this.frontmatterManager.write(file, {
            sys_id: newDoc.sys_id,
            synced: true,
          });
          this.fileWatcher.removeSyncWritePath(file.path);

          this.plugin.syncState.docMap[newDoc.sys_id] = {
            sysId: newDoc.sys_id,
            path: file.path,
            lastServerTimestamp: newDoc.sys_updated_on,
            lockedBy: "",
            lockedAt: "",
          };

          result.pushed++;
          if ((i + 1) % 10 === 0) {
            new Notice(`Bulk push: ${i + 1}/${total} uploaded`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Error: ${file.basename} — ${msg}`);
        }
      }

      this.plugin.syncState.lastSyncTimestamp = new Date().toISOString();
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
    } finally {
      this.isSyncing = false;
      const summary = `Bulk push complete: ${result.pushed} uploaded, ${result.errors.length} errors`;
      new Notice(summary);
      console.log(`Snobby: ${summary}`);
      if (result.errors.length > 0) {
        console.error("Snobby: Bulk push errors:", result.errors);
      }
      this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    }
    return result;
  }

  async bulkUpdate(): Promise<SyncResult> {
    if (this.isSyncing) return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
    this.isSyncing = true;
    this.plugin.updateStatusBar("syncing");

    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };

    try {
      const allFiles = this.plugin.app.vault.getMarkdownFiles();
      const candidates: TFile[] = [];

      for (const file of allFiles) {
        const fm = await this.frontmatterManager.read(file);
        if (fm.sys_id) {
          candidates.push(file);
        }
      }

      const total = candidates.length;
      new Notice(`Bulk update: ${total} documents to re-sync`);
      console.log(`Snobby: Bulk update starting — ${total} files`);

      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        try {
          const fm = await this.frontmatterManager.read(file);
          const content = await this.getFileContent(file);

          const updateResult = await this.apiClient.updateDocument(fm.sys_id!, {
            title: file.basename,
            content,
          });

          if (!updateResult.ok) {
            result.errors.push(`Failed: ${file.basename} (HTTP ${updateResult.status})`);
            continue;
          }

          this.fileWatcher.addSyncWritePath(file.path);
          await this.frontmatterManager.markSynced(file);
          this.fileWatcher.removeSyncWritePath(file.path);

          result.pushed++;

          if ((i + 1) % 10 === 0) {
            new Notice(`Bulk update: ${i + 1}/${total} updated`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Error: ${file.basename} — ${msg}`);
        }
      }

      this.plugin.syncState.lastSyncTimestamp = new Date().toISOString();
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
    } finally {
      this.isSyncing = false;
      const summary = `Bulk update complete: ${result.pushed} updated, ${result.errors.length} errors`;
      new Notice(summary);
      console.log(`Snobby: ${summary}`);
      if (result.errors.length > 0) {
        console.error("Snobby: Bulk update errors:", result.errors);
      }
      this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    }
    return result;
  }

  private async pull(result: SyncResult) {
    const since = this.plugin.syncState.lastSyncTimestamp;
    if (!since) return;

    const response = await this.apiClient.getChanges(since);
    if (!response.ok || !response.data) {
      if (response.status !== 0) result.errors.push(`Pull failed: HTTP ${response.status}`);
      return;
    }

    const docs = Array.isArray(response.data) ? response.data : [response.data];
    for (const doc of docs) {
        if (this.plugin.syncState.ignoredIds.includes(doc.sys_id)) continue;

      try {
        await this.handlePulledDoc(doc, result);
        this.plugin.updateSyncProgress(result.pulled, result.pushed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Pull error for ${doc.title}: ${msg}`);
      }
    }
  }

  private updateLockState(entry: { lockedBy: string; lockedAt: string }, doc: SNDocument) {
    entry.lockedBy = doc.checked_out_by || "";
    entry.lockedAt = doc.checked_out_by ? doc.sys_updated_on : "";
  }

  private async handlePulledDoc(doc: SNDocument, result: SyncResult) {
    const mapEntry = this.plugin.syncState.docMap[doc.sys_id];

    if (mapEntry) {
      this.updateLockState(mapEntry, doc);

      const file = this.plugin.app.vault.getAbstractFileByPath(mapEntry.path);
      if (!(file instanceof TFile)) {
        await this.createLocalFile(doc);
        result.pulled++;
        return;
      }

      // sys_updated_on can bump for non-content reasons, so compare actual content
      const localContent = await this.getFileContent(file);
      const contentChanged = localContent !== doc.content;

      if (!contentChanged) {
        mapEntry.lastServerTimestamp = doc.sys_updated_on;
      } else {
        const fm = await this.frontmatterManager.read(file);
        if (fm.synced === false) {
          this.conflictResolver.applyConflict(doc.sys_id, mapEntry.path, doc.content, doc.sys_updated_on, doc.checked_out_by || "");
          result.conflicts++;
        } else {
          this.fileWatcher.addSyncWritePath(file.path);
          await this.plugin.app.vault.modify(file, doc.content);
          this.fileWatcher.removeSyncWritePath(file.path);
          mapEntry.lastServerTimestamp = doc.sys_updated_on;
          result.pulled++;
        }
      }
    } else {
      await this.createLocalFile(doc);
      result.pulled++;
    }
  }

  private async push(result: SyncResult) {
    const dirtyFiles = await this.fileWatcher.getDirtyFiles();

    for (const file of dirtyFiles) {
      try {
        await this.handlePushFile(file, result);
        this.plugin.updateSyncProgress(result.pulled, result.pushed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Push error for ${file.name}: ${msg}`);
      }
    }
  }

  private isLockedByOther(sysId: string): string | null {
    const entry = this.plugin.syncState.docMap[sysId];
    if (!entry?.lockedBy) return null;
    const username = this.plugin.settings.username;
    if (username && entry.lockedBy === username) return null;
    return entry.lockedBy;
  }

  private async warnLockedDirtyFiles() {
    const username = this.plugin.settings.username;
    let warned = 0;

    for (const entry of Object.values(this.plugin.syncState.docMap)) {
      if (warned >= 3) break;
      if (!entry.lockedBy) continue;
      if (username && entry.lockedBy === username) continue;

      const file = this.plugin.app.vault.getAbstractFileByPath(entry.path);
      if (!(file instanceof TFile)) continue;

      const fm = await this.frontmatterManager.read(file);
      if (fm.synced !== false) continue;

      const fileName = entry.path.split("/").pop() ?? entry.path;
      new Notice(`${fileName} was locked by ${entry.lockedBy}. Your local changes can't sync until the lock is released.`);
      warned++;
    }
  }

  private async handlePushFile(file: TFile, result: SyncResult) {
    const fm = await this.frontmatterManager.read(file);
    const content = await this.getFileContent(file);

    if (fm.sys_id && this.plugin.syncState.conflicts[fm.sys_id]) return;

    if (fm.sys_id) {
      const lockedByOther = this.isLockedByOther(fm.sys_id);
      if (lockedByOther) {
        new Notice(`Cannot push "${file.basename}": locked by ${lockedByOther}`);
        return;
      }

      const checkoutResult = await this.apiClient.checkout(fm.sys_id);
      if (!checkoutResult.ok) {
        if (checkoutResult.status === 423) {
          const lockedBy = (checkoutResult.data as SNDocument | null)?.checked_out_by ?? "another user";
          new Notice(`Cannot push "${file.basename}": checked out by ${lockedBy}`);
        } else {
          result.errors.push(`Checkout failed for ${file.basename}: HTTP ${checkoutResult.status}`);
        }
        return;
      }

      const updateResult = await this.apiClient.updateDocument(fm.sys_id, {
        content,
        title: file.basename,
      });

      if (!updateResult.ok) {
        if (updateResult.status === 409) {
          const latest = await this.apiClient.getDocument(fm.sys_id);
          if (latest.ok && latest.data) {
            if (latest.data.content === content) {
              await this.apiClient.checkin(fm.sys_id);
              this.fileWatcher.addSyncWritePath(file.path);
              await this.frontmatterManager.markSynced(file);
              this.fileWatcher.removeSyncWritePath(file.path);
              result.pushed++;
            } else {
              this.conflictResolver.applyConflict(fm.sys_id, file.path, latest.data.content, latest.data.sys_updated_on, latest.data.checked_out_by || "");
              result.conflicts++;
            }
          }
        } else {
          result.errors.push(`Update failed for ${file.basename}: HTTP ${updateResult.status}`);
        }
        return;
      }

      await this.apiClient.checkin(fm.sys_id);

      this.fileWatcher.addSyncWritePath(file.path);
      await this.frontmatterManager.markSynced(file);
      this.fileWatcher.removeSyncWritePath(file.path);

      const entry = this.plugin.syncState.docMap[fm.sys_id];
      if (entry) {
        if (updateResult.data) {
          entry.lastServerTimestamp = updateResult.data.sys_updated_on;
        }
        entry.lockedBy = "";
        entry.lockedAt = "";
      }

      new Notice(`Unlocked "${file.basename}" on ServiceNow`);
      result.pushed++;
    } else {
      let category = fm.category ?? "";
      let project = fm.project ?? "";
      let tags = fm.tags ?? "";

      if (!category && !project) {
        if (!this.cachedMetadata) {
          const metaResponse = await this.apiClient.getMetadata();
          if (metaResponse.ok && metaResponse.data) {
            this.cachedMetadata = metaResponse.data;
          }
        }

        const snMeta = this.cachedMetadata ?? { categories: [], projects: [], tags: [] };
        const userInput = await promptNewDocMetadata(this.plugin.app, snMeta, {
          category,
          project,
          tags,
        });

        if (!userInput) return;
        category = userInput.category;
        project = userInput.project;
        tags = userInput.tags;
      }

      const createResult = await this.apiClient.createDocument({
        title: file.basename,
        content,
        category,
        project,
        tags,
      });

      if (!createResult.ok || !createResult.data) {
        result.errors.push(`Create failed for ${file.basename}: HTTP ${createResult.status}`);
        return;
      }

      const newDoc = createResult.data;

      this.fileWatcher.addSyncWritePath(file.path);
      await this.frontmatterManager.write(file, {
        sys_id: newDoc.sys_id,
        category: newDoc.category,
        project: newDoc.project,
        tags: newDoc.tags,
        synced: true,
      });
      this.fileWatcher.removeSyncWritePath(file.path);

      this.plugin.syncState.docMap[newDoc.sys_id] = {
        sysId: newDoc.sys_id,
        path: file.path,
        lastServerTimestamp: newDoc.sys_updated_on,
        lockedBy: "",
        lockedAt: "",
      };

      result.pushed++;
    }
  }

  private resolveLabel(type: "projects" | "categories", value: string): string {
    if (!this.cachedMetadata || !value) return value;
    const entry = this.cachedMetadata[type].find((e) => e.value === value);
    return entry?.label ?? value;
  }

  async ensureMetadata() {
    if (this.cachedMetadata) return;
    const response = await this.apiClient.getMetadata();
    if (response.ok && response.data) {
      this.cachedMetadata = response.data;
    }
  }

  async createLocalFile(doc: SNDocument) {
    const existing = this.plugin.syncState.docMap[doc.sys_id];
    if (existing) {
      const file = this.plugin.app.vault.getAbstractFileByPath(existing.path);
      if (file) return;
    }

    const { folderMapping } = this.plugin.settings;

    await this.ensureMetadata();
    const projectLabel = this.resolveLabel("projects", doc.project);
    const categoryLabel = doc.category;

    const filePath = normalizePath(
      resolveFilePath(folderMapping, doc.title, projectLabel, categoryLabel, "")
    );

    const finalPath = await this.resolveCollision(filePath, doc.sys_id);

    const parentDir = finalPath.substring(0, finalPath.lastIndexOf("/"));
    if (parentDir) {
      await this.ensureFolderExists(parentDir);
    }

    this.fileWatcher.addSyncWritePath(finalPath);
    await this.plugin.app.vault.create(finalPath, doc.content);
    this.fileWatcher.removeSyncWritePath(finalPath);

    this.plugin.syncState.docMap[doc.sys_id] = {
      sysId: doc.sys_id,
      path: finalPath,
      lastServerTimestamp: doc.sys_updated_on,
      lockedBy: doc.checked_out_by || "",
      lockedAt: doc.checked_out_by ? doc.sys_updated_on : "",
    };
  }

  async ensureFolderExists(folderPath: string) {
    if (this.plugin.app.vault.getAbstractFileByPath(folderPath)) return;
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
        await this.plugin.app.vault.createFolder(current);
      }
    }
  }

  async resolveCollision(path: string, sysId: string): Promise<string> {
    if (!this.plugin.app.vault.getAbstractFileByPath(path)) return path;

    const ext = ".md";
    const base = path.slice(0, -ext.length);
    let candidate = `${base} (${sysId.slice(0, 6)})${ext}`;
    let counter = 2;
    while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${base} (${sysId.slice(0, 6)}-${counter})${ext}`;
      counter++;
    }
    return candidate;
  }

  private async getFileContent(file: TFile): Promise<string> {
    return this.plugin.app.vault.read(file);
  }
}
