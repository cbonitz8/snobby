import { TFile, Notice, normalizePath } from "obsidian";
import type SNSyncPlugin from "./main";
import type { ApiClient } from "./api-client";
import type { FrontmatterManager } from "./frontmatter-manager";
import type { FileWatcher } from "./file-watcher";
import type { ConflictResolver } from "./conflict-resolver";
import type { SNDocument, SNMetadata, SyncResult } from "./types";
import { resolveFilePath } from "./folder-mapper";
import { hasConflictMarkers } from "./conflict-resolver";
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

  /** Start the sync engine based on settings */
  start() {
    if (this.plugin.settings.syncMode === "interval") {
      this.startInterval();
    }
  }

  /** Stop the sync engine */
  stop() {
    this.stopInterval();
  }

  /** Restart (e.g. after settings change) */
  restart() {
    this.stop();
    this.start();
  }

  private startInterval() {
    this.stopInterval();
    const ms = this.plugin.settings.syncIntervalSeconds * 1000;
    this.intervalId = window.setInterval(() => this.sync(), ms);
    // Register so Obsidian cleans up on unload
    this.plugin.registerInterval(this.intervalId);
  }

  private stopInterval() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Run a full sync cycle: pull then push */
  async sync(): Promise<SyncResult> {
    if (this.isSyncing) return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
    this.isSyncing = true;
    this.plugin.updateStatusBar("syncing");

    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };

    try {
      await this.pull(result);
      await this.push(result);
      this.plugin.syncState.lastSyncTimestamp = new Date().toISOString();
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
      console.error("SN Sync: Sync cycle error", e);
    }

    this.isSyncing = false;
    if (result.errors.length > 0) {
      console.error("SN Sync: Sync errors:", result.errors);
      new Notice(`SN Sync errors:\n${result.errors.join("\n")}`);
    }
    this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    return result;
  }

  /** Run initial full pull — used on first setup */
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
    }

    this.isSyncing = false;
    if (result.errors.length > 0) {
      console.error("SN Sync: Initial pull errors:", result.errors);
      new Notice(`SN Sync errors:\n${result.errors.join("\n")}`);
    }
    this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    return result;
  }

  /** Bulk push all local files that have sn_ metadata but no sys_id yet */
  async bulkPush(): Promise<SyncResult> {
    if (this.isSyncing) return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
    this.isSyncing = true;
    this.plugin.updateStatusBar("syncing");

    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };

    try {
      const allFiles = this.plugin.app.vault.getMarkdownFiles();
      const candidates: TFile[] = [];

      // Find files with sn_category but no sn_sys_id
      for (const file of allFiles) {
        const fm = await this.frontmatterManager.read(file);
        if (fm.category && !fm.sys_id) {
          candidates.push(file);
        }
      }

      const total = candidates.length;
      new Notice(`Bulk push: ${total} documents to upload`);
      console.log(`SN Sync: Bulk push starting — ${total} files`);

      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        try {
          const fm = await this.frontmatterManager.read(file);
          const content = await this.getContentWithoutFrontmatter(file);

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

          // Write sys_id back and mark synced
          this.fileWatcher.addSyncWritePath(file.path);
          await this.frontmatterManager.write(file, {
            sys_id: newDoc.sys_id,
            synced: true,
          });
          this.fileWatcher.removeSyncWritePath(file.path);

          // Track in docMap
          this.plugin.syncState.docMap[newDoc.sys_id] = {
            sysId: newDoc.sys_id,
            path: file.path,
            lastServerTimestamp: newDoc.sys_updated_on,
          };

          result.pushed++;

          // Progress notice every 10 files
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
    }

    this.isSyncing = false;
    const summary = `Bulk push complete: ${result.pushed} uploaded, ${result.errors.length} errors`;
    new Notice(summary);
    console.log(`SN Sync: ${summary}`);
    if (result.errors.length > 0) {
      console.error("SN Sync: Bulk push errors:", result.errors);
    }
    this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    return result;
  }

  // --- Pull Phase ---

  private async pull(result: SyncResult) {
    const since = this.plugin.syncState.lastSyncTimestamp;
    if (!since) return; // No previous sync — need initialPull instead

    const response = await this.apiClient.getChanges(since);
    if (!response.ok || !response.data) {
      if (response.status !== 0) result.errors.push(`Pull failed: HTTP ${response.status}`);
      return;
    }

    const docs = Array.isArray(response.data) ? response.data : [response.data];
    for (const doc of docs) {
      // Skip ignored docs
      if (this.plugin.syncState.ignoredIds.includes(doc.sys_id)) continue;

      try {
        await this.handlePulledDoc(doc, result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Pull error for ${doc.title}: ${msg}`);
      }
    }
  }

  private async handlePulledDoc(doc: SNDocument, result: SyncResult) {
    const mapEntry = this.plugin.syncState.docMap[doc.sys_id];

    if (mapEntry) {
      // File exists locally
      const file = this.plugin.app.vault.getAbstractFileByPath(mapEntry.path);
      if (!(file instanceof TFile)) {
        // File was deleted outside our watcher — re-create
        await this.createLocalFile(doc);
        result.pulled++;
        return;
      }

      // Content comparison: sys_updated_on can bump for non-content reasons
      // (lock cleanup, metadata-only updates), so compare actual content
      const localContent = await this.getContentWithoutFrontmatter(file);
      const contentChanged = localContent !== doc.content;

      if (!contentChanged) {
        // Content is identical — only update frontmatter metadata (lock status, etc.)
        this.fileWatcher.addSyncWritePath(file.path);
        await this.frontmatterManager.write(file, {
          category: doc.category,
          project: doc.project,
          tags: doc.tags,
        });
        this.fileWatcher.removeSyncWritePath(file.path);
        mapEntry.lastServerTimestamp = doc.sys_updated_on;
      } else {
        // Content actually differs
        const fm = await this.frontmatterManager.read(file);
        if (fm.synced === false) {
          // Local is dirty AND remote content changed — real conflict
          await this.conflictResolver.applyConflict(file, doc.content);
          result.conflicts++;
        } else {
          // Local is clean — safe to overwrite with remote content
          this.fileWatcher.addSyncWritePath(file.path);
          const prefix = this.plugin.settings.frontmatterPrefix;
          const frontmatter = [
            "---",
            `${prefix}sys_id: ${doc.sys_id}`,
            `${prefix}category: ${doc.category}`,
            `${prefix}project: "${doc.project}"`,
            `${prefix}tags: "${doc.tags}"`,
            `${prefix}synced: true`,
            "---",
            "",
          ].join("\n");
          await this.plugin.app.vault.modify(file, frontmatter + doc.content);
          this.fileWatcher.removeSyncWritePath(file.path);
          mapEntry.lastServerTimestamp = doc.sys_updated_on;
          result.pulled++;
        }
      }
    } else {
      // New doc from server
      await this.createLocalFile(doc);
      result.pulled++;
    }
  }

  // --- Push Phase ---

  private async push(result: SyncResult) {
    const dirtyFiles = await this.fileWatcher.getDirtyFiles();

    for (const file of dirtyFiles) {
      try {
        await this.handlePushFile(file, result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Push error for ${file.name}: ${msg}`);
      }
    }
  }

  private async handlePushFile(file: TFile, result: SyncResult) {
    const fm = await this.frontmatterManager.read(file);
    const content = await this.getContentWithoutFrontmatter(file);

    // Don't push files with unresolved conflicts
    if (hasConflictMarkers(content)) return;

    if (fm.sys_id) {
      // Existing doc — checkout, update, checkin
      const checkoutResult = await this.apiClient.checkout(fm.sys_id);
      if (!checkoutResult.ok && checkoutResult.status === 423) {
        const lockedBy = (checkoutResult.data as SNDocument | null)?.checked_out_by ?? "another user";
        new Notice(`Cannot push "${file.basename}": checked out by ${lockedBy}`);
        return;
      }

      const updateResult = await this.apiClient.updateDocument(fm.sys_id, {
        content,
        title: file.basename,
      });

      if (!updateResult.ok) {
        if (updateResult.status === 409) {
          // Server-side conflict — compare content before injecting markers
          const latest = await this.apiClient.getDocument(fm.sys_id);
          if (latest.ok && latest.data) {
            if (latest.data.content === content) {
              // Content is identical — no real conflict, re-acquire lock and push
              await this.apiClient.checkout(fm.sys_id);
              const retryResult = await this.apiClient.updateDocument(fm.sys_id, {
                content,
                title: file.basename,
              });
              if (retryResult.ok) {
                await this.apiClient.checkin(fm.sys_id);
                this.fileWatcher.addSyncWritePath(file.path);
                await this.frontmatterManager.markSynced(file);
                this.fileWatcher.removeSyncWritePath(file.path);
                result.pushed++;
              }
            } else {
              // Content actually differs — real conflict
              await this.conflictResolver.applyConflict(file, latest.data.content);
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

      // Update docMap timestamp
      const entry = this.plugin.syncState.docMap[fm.sys_id];
      if (entry && updateResult.data) {
        entry.lastServerTimestamp = updateResult.data.sys_updated_on;
      }

      result.pushed++;
    } else {
      // New doc — use frontmatter metadata if available, otherwise prompt
      let category = fm.category ?? "";
      let project = fm.project ?? "";
      let tags = fm.tags ?? "";

      if (!category && !project) {
        // No metadata in frontmatter — prompt the user
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

        if (!userInput) return; // User cancelled
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

      // Add to docMap
      this.plugin.syncState.docMap[newDoc.sys_id] = {
        sysId: newDoc.sys_id,
        path: file.path,
        lastServerTimestamp: newDoc.sys_updated_on,
      };

      result.pushed++;
    }
  }

  // --- Helpers ---

  async createLocalFile(doc: SNDocument) {
    const { folderMapping, frontmatterPrefix } = this.plugin.settings;

    const filePath = normalizePath(
      resolveFilePath(folderMapping, doc.title, doc.project, doc.category, "")
    );

    // Handle title collisions
    const finalPath = await this.resolveCollision(filePath, doc.sys_id);

    // Ensure parent directories exist (recursive)
    const parentDir = finalPath.substring(0, finalPath.lastIndexOf("/"));
    if (parentDir) {
      await this.ensureFolderExists(parentDir);
    }

    // Build frontmatter
    const prefix = frontmatterPrefix;
    const frontmatter = [
      "---",
      `${prefix}sys_id: ${doc.sys_id}`,
      `${prefix}category: ${doc.category}`,
      `${prefix}project: "${doc.project}"`,
      `${prefix}tags: "${doc.tags}"`,
      `${prefix}synced: true`,
      "---",
      "",
    ].join("\n");

    this.fileWatcher.addSyncWritePath(finalPath);
    await this.plugin.app.vault.create(finalPath, frontmatter + doc.content);
    this.fileWatcher.removeSyncWritePath(finalPath);

    // Track in docMap
    this.plugin.syncState.docMap[doc.sys_id] = {
      sysId: doc.sys_id,
      path: finalPath,
      lastServerTimestamp: doc.sys_updated_on,
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
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!existing) return path;

    // Append sys_id to avoid collision: "My Doc (abc123).md"
    const ext = ".md";
    const base = path.slice(0, -ext.length);
    return `${base} (${sysId.slice(0, 6)})${ext}`;
  }

  private async getContentWithoutFrontmatter(file: TFile): Promise<string> {
    const raw = await this.plugin.app.vault.read(file);
    if (!raw.startsWith("---")) return raw;
    const endIndex = raw.indexOf("---", 3);
    if (endIndex === -1) return raw;
    return raw.slice(endIndex + 3).replace(/^\n+/, "");
  }
}
