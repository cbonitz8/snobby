import { TFile, Notice, normalizePath } from "obsidian";
import type SNSyncPlugin from "./main";
import type { ApiClient } from "./api-client";
import type { FrontmatterManager } from "./frontmatter-manager";
import type { FileWatcher } from "./file-watcher";
import type { ConflictResolver } from "./conflict-resolver";
import type { SNDocument, SNMetadata, SyncResult, ConflictResponseData } from "./types";
import type { BaseCache } from "./base-cache";
import { resolveFilePath, sanitizePathSegment, isTopLevelCategory } from "./folder-mapper";
import { promptNewDocMetadata } from "./new-doc-modal";
import { stripFrontmatter } from "./frontmatter-manager";
import { parseSections } from "./section-parser";
import { mergeSections } from "./section-merger";

function sanitizeErrorMsg(msg: string): string {
  return msg.split("\n")[0]!.slice(0, 200);
}

export class SyncEngine {
  private plugin: SNSyncPlugin;
  private apiClient: ApiClient;
  private frontmatterManager: FrontmatterManager;
  private fileWatcher: FileWatcher;
  private conflictResolver: ConflictResolver;
  private baseCache: BaseCache;
  private intervalId: number | null = null;
  private isSyncing = false;
  private cachedMetadata: SNMetadata | null = null;
  private skipPullSysIds = new Set<string>();
  constructor(
    plugin: SNSyncPlugin,
    apiClient: ApiClient,
    frontmatterManager: FrontmatterManager,
    fileWatcher: FileWatcher,
    conflictResolver: ConflictResolver,
    baseCache: BaseCache
  ) {
    this.plugin = plugin;
    this.apiClient = apiClient;
    this.frontmatterManager = frontmatterManager;
    this.fileWatcher = fileWatcher;
    this.conflictResolver = conflictResolver;
    this.baseCache = baseCache;
  }

  addSkipPullId(sysId: string) {
    this.skipPullSysIds.add(sysId);
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
    this.intervalId = window.setInterval(() => void this.sync(), ms);
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
      await this.fileWatcher.flushPending();
      const pullTs = await this.pull(result);
      const pushTs = await this.push(result);
      const serverTs = [pullTs, pushTs].filter(Boolean).sort().pop();
      if (serverTs) {
        this.plugin.syncState.lastSyncTimestamp = serverTs;
      }
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
      console.error("Snobby: Sync cycle error", e);
    } finally {
      this.isSyncing = false;
      if (result.errors.length > 0) {
        console.error("Snobby: Sync errors:", result.errors);
        new Notice(`Snobby errors:\n${result.errors.join("\n")}`);
      } else {
        const parts: string[] = [];
        if (result.pulled > 0) parts.push(`${result.pulled} pulled`);
        if (result.pushed > 0) parts.push(`${result.pushed} pushed`);
        const totalConflicts = Object.keys(this.plugin.syncState.conflicts).length;
        if (totalConflicts > 0) {
          parts.push(`${totalConflicts} conflict${totalConflicts > 1 ? "s" : ""}`);
          const frag = document.createDocumentFragment();
          const container = frag.createEl("div", { cls: "sn-conflict-notice" });
          container.createEl("div", {
            text: `Snobby: ${parts.join(", ")}`,
            cls: "sn-conflict-notice-title",
          });
          const viewBtn = container.createEl("button", {
            text: "View conflicts",
            cls: "sn-action-btn sn-conflict-notice-btn",
          });
          const notice = new Notice(frag, 0);
          viewBtn.addEventListener("click", () => {
            const firstSysId = Object.keys(this.plugin.syncState.conflicts)[0];
            if (firstSysId) {
              void this.plugin.openConflictInBrowser(firstSysId);
            }
            notice.hide();
          });
        } else {
          new Notice(parts.length > 0 ? `Snobby: ${parts.join(", ")}` : "Snobby: everything up to date");
        }
      }
      this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
      this.plugin.refreshBrowserView();
    }
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
      let latestTs: string | null = null;

      for (const doc of docs) {
        if (!latestTs || doc.sys_updated_on > latestTs) {
          latestTs = doc.sys_updated_on;
        }
        try {
          await this.createLocalFile(doc);
          result.pulled++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Failed to create ${doc.title}: ${sanitizeErrorMsg(msg)}`);
        }
      }

      if (latestTs) {
        this.plugin.syncState.lastSyncTimestamp = latestTs;
      }
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

  async deleteAllAndRepull(): Promise<SyncResult> {
    if (this.isSyncing) return { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
    this.isSyncing = true;
    this.plugin.updateStatusBar("syncing");

    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };

    try {
      const docMap = this.plugin.syncState.docMap;
      const entries = Object.values(docMap);
      let deleted = 0;

      for (const entry of entries) {
        const file = this.plugin.app.vault.getAbstractFileByPath(entry.path);
        if (file instanceof TFile) {
          this.fileWatcher.addSyncWritePath(entry.path);
          try {
            await this.plugin.app.fileManager.trashFile(file);
          } finally {
            this.fileWatcher.removeSyncWritePath(entry.path);
          }
          deleted++;
        }
      }

      this.plugin.syncState.docMap = {};
      this.plugin.syncState.conflicts = {};
      this.plugin.syncState.lastSyncTimestamp = "";
      await this.plugin.saveSettings();

      new Notice(`Deleted ${deleted} local files. Re-pulling from ServiceNow...`);

      const pullResult = await this.initialPull();
      result.pulled = pullResult.pulled;
      result.errors = pullResult.errors;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
    } finally {
      this.isSyncing = false;
      const summary = `Re-pull complete: ${result.pulled} downloaded, ${result.errors.length} errors`;
      new Notice(summary);
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
        const fm = this.frontmatterManager.read(file);
        if (fm.category && !fm.sys_id) {
          candidates.push(file);
        }
      }

      const total = candidates.length;
      new Notice(`Bulk push: ${total} documents to upload`);
      let latestTs: string | null = null;

      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        try {
          const fm = this.frontmatterManager.read(file);
          const content = await this.getContentForPush(file);

          await this.ensureMetadata();
          const createResult = await this.apiClient.createDocument({
            title: file.basename,
            content,
            category: this.resolveValue("categories", fm.category ?? ""),
            project: this.resolveValue("projects", fm.project ?? ""),
            tags: fm.tags ?? "",
          });

          if (!createResult.ok || !createResult.data) {
            result.errors.push(`Failed: ${file.basename} (HTTP ${createResult.status})`);
            continue;
          }

          const newDoc = createResult.data;
          if (!latestTs || newDoc.sys_updated_on > latestTs) {
            latestTs = newDoc.sys_updated_on;
          }

          this.fileWatcher.addSyncWritePath(file.path);
          try {
            await this.frontmatterManager.write(file, {
              sys_id: newDoc.sys_id,
              synced: true,
            });
          } finally {
            this.fileWatcher.removeSyncWritePath(file.path);
          }

          this.plugin.syncState.docMap[newDoc.sys_id] = {
            sysId: newDoc.sys_id,
            path: file.path,
            lastServerTimestamp: newDoc.sys_updated_on,
            contentHash: newDoc.content_hash ?? "",
          };

          await this.baseCache.saveBase(newDoc.sys_id, stripFrontmatter(content));
          result.pushed++;
          if ((i + 1) % 10 === 0) {
            new Notice(`Bulk push: ${i + 1}/${total} uploaded`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Error: ${file.basename} — ${msg}`);
        }
      }

      if (latestTs) {
        this.plugin.syncState.lastSyncTimestamp = latestTs;
      }
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
    } finally {
      this.isSyncing = false;
      const summary = `Bulk push complete: ${result.pushed} uploaded, ${result.errors.length} errors`;
      new Notice(summary);
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
        const fm = this.frontmatterManager.read(file);
        if (fm.sys_id) {
          candidates.push(file);
        }
      }

      const total = candidates.length;
      new Notice(`Bulk update: ${total} documents to re-sync`);
      let latestTs: string | null = null;

      for (let i = 0; i < candidates.length; i++) {
        const file = candidates[i]!;
        try {
          const fm = this.frontmatterManager.read(file);
          const content = await this.getContentForPush(file);

          const updateResult = await this.apiClient.updateDocument(fm.sys_id!, {
            title: file.basename,
            content,
          });

          if (!updateResult.ok) {
            result.errors.push(`Failed: ${file.basename} (HTTP ${updateResult.status})`);
            continue;
          }

          if (updateResult.data?.sys_updated_on) {
            const ts = updateResult.data.sys_updated_on;
            if (!latestTs || ts > latestTs) latestTs = ts;
          }

          this.fileWatcher.addSyncWritePath(file.path);
          try {
            await this.frontmatterManager.markSynced(file);
          } finally {
            this.fileWatcher.removeSyncWritePath(file.path);
          }

          result.pushed++;

          if ((i + 1) % 10 === 0) {
            new Notice(`Bulk update: ${i + 1}/${total} updated`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Error: ${file.basename} — ${msg}`);
        }
      }

      if (latestTs) {
        this.plugin.syncState.lastSyncTimestamp = latestTs;
      }
      await this.plugin.saveSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(msg);
    } finally {
      this.isSyncing = false;
      const summary = `Bulk update complete: ${result.pushed} updated, ${result.errors.length} errors`;
      new Notice(summary);
      if (result.errors.length > 0) {
        console.error("Snobby: Bulk update errors:", result.errors);
      }
      this.plugin.updateStatusBar(result.errors.length > 0 ? "error" : "idle");
    }
    return result;
  }

  private async pull(result: SyncResult): Promise<string | null> {
    const since = this.plugin.syncState.lastSyncTimestamp;
    if (!since) return null;

    const response = await this.apiClient.getChanges(since);
    if (!response.ok || !response.data) {
      if (response.status !== 0) result.errors.push(`Pull failed: HTTP ${response.status}`);
      return null;
    }

    const docs = Array.isArray(response.data) ? response.data : [response.data];
    let latestTs: string | null = null;

    for (const doc of docs) {
        if (this.plugin.syncState.ignoredIds.includes(doc.sys_id)) continue;

      if (!latestTs || doc.sys_updated_on > latestTs) {
        latestTs = doc.sys_updated_on;
      }

      try {
        await this.handlePulledDoc(doc, result);
        this.plugin.updateSyncProgress(result.pulled, result.pushed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Pull error for ${doc.title}: ${sanitizeErrorMsg(msg)}`);
      }
    }

    return latestTs;
  }

  private async handlePulledDoc(doc: SNDocument, result: SyncResult) {
    if (this.skipPullSysIds.has(doc.sys_id)) return;

    const mapEntry = this.plugin.syncState.docMap[doc.sys_id];

    if (mapEntry) {

      const file = this.plugin.app.vault.getAbstractFileByPath(mapEntry.path);
      if (!(file instanceof TFile)) {
        await this.createLocalFile(doc);
        result.pulled++;
        return;
      }

      // sys_updated_on can bump for non-content reasons, so compare actual body content
      const localBody = await this.getBodyContent(file);
      const contentChanged = localBody !== stripFrontmatter(doc.content);

      if (!contentChanged) {
        mapEntry.lastServerTimestamp = doc.sys_updated_on;
        mapEntry.contentHash = doc.content_hash ?? "";
      } else {
        const fm = this.frontmatterManager.read(file);
        // Metadata cache can be stale — also check if local body differs from last known base.
        // If no base cache exists, re-read synced flag directly from file to avoid metadata cache race.
        const baseBody = await this.baseCache.loadBase(doc.sys_id);
        let localDirty = fm.synced === false || (baseBody !== null && localBody !== baseBody);
        if (!localDirty && baseBody === null) {
          // No base to compare — re-read file to check synced flag directly
          const raw = await this.plugin.app.vault.read(file);
          const pfx = this.plugin.settings.frontmatterPrefix;
          const syncedMatch = raw.match(new RegExp(`${pfx}synced:\\s*(true|false|"true"|"false")`));
          if (syncedMatch && (syncedMatch[1] === "false" || syncedMatch[1] === '"false"')) {
            localDirty = true;
          }
        }
        if (localDirty) {
          // Both sides changed — attempt section-level merge
          const remoteBody = stripFrontmatter(doc.content);
          const baseSections = baseBody ? parseSections(baseBody) : null;
          const localSections = parseSections(localBody);
          const remoteSections = parseSections(remoteBody);
          const mergeResult = mergeSections(baseSections, localSections, remoteSections);

          if (!mergeResult.hasConflicts) {
            // Auto-merge succeeded
            this.fileWatcher.addSyncWritePath(file.path);
            try {
              const merged = await this.rebuildWithFrontmatter(file, mergeResult.mergedBody);
              await this.plugin.app.vault.modify(file, merged);
              await this.frontmatterManager.write(file, { ...fm, synced: false });
            } finally {
              this.fileWatcher.removeSyncWritePath(file.path);
            }
            await this.baseCache.saveBase(doc.sys_id, mergeResult.mergedBody);
            mapEntry.lastServerTimestamp = doc.sys_updated_on;
            mapEntry.contentHash = doc.content_hash ?? "";
            result.pulled++;
          } else {
            this.conflictResolver.applyConflict({
              sysId: doc.sys_id,
              path: mapEntry.path,
              remoteContent: doc.content,
              remoteTimestamp: doc.sys_updated_on,
              sectionConflicts: mergeResult.conflicts,
            });
            result.conflicts++;
          }
        } else {
          // Local is clean — overwrite with remote
          this.fileWatcher.addSyncWritePath(file.path);
          try {
            await this.plugin.app.vault.modify(file, doc.content);
            await this.frontmatterManager.write(file, {
              sys_id: fm.sys_id,
              category: fm.category,
              project: fm.project,
              tags: fm.tags,
              synced: true,
            });
          } finally {
            this.fileWatcher.removeSyncWritePath(file.path);
          }
          await this.baseCache.saveBase(doc.sys_id, stripFrontmatter(doc.content));
          mapEntry.lastServerTimestamp = doc.sys_updated_on;
          mapEntry.contentHash = doc.content_hash ?? "";
          result.pulled++;
        }
      }
    } else {
      await this.createLocalFile(doc);
      result.pulled++;
    }
  }

  private async push(result: SyncResult): Promise<string | null> {
    const dirtyFiles = this.fileWatcher.getDirtyFiles();
    let latestTs: string | null = null;

    for (const file of dirtyFiles) {
      try {
        const pushTs = await this.handlePushFile(file, result);
        if (pushTs && (!latestTs || pushTs > latestTs)) {
          latestTs = pushTs;
        }
        this.plugin.updateSyncProgress(result.pulled, result.pushed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Push error for ${file.name}: ${msg}`);
      }
    }

    this.skipPullSysIds.clear();
    return latestTs;
  }

  private async handlePushFile(file: TFile, result: SyncResult): Promise<string | null> {
    const fm = this.frontmatterManager.read(file);
    const content = await this.getContentForPush(file);

    if (fm.sys_id && this.plugin.syncState.conflicts[fm.sys_id]) return null;
    if (this.conflictResolver.getConflictForPath(file.path)) return null;

    if (fm.sys_id) {
      const mapEntry = this.plugin.syncState.docMap[fm.sys_id];
      const expectedHash = mapEntry?.contentHash;
      const updateResult = await this.apiClient.updateDocument(fm.sys_id, {
        content,
        title: file.basename,
        ...(expectedHash ? { expected_hash: expectedHash } : {}),
      });

      if (!updateResult.ok) {
        if (updateResult.status === 409) {
          const conflictData = updateResult.data as ConflictResponseData | null;

          if (conflictData?.content) {
            const remoteBody = stripFrontmatter(conflictData.content);
            const localBody = stripFrontmatter(content);

            if (remoteBody === localBody) {
              // Content converged — no real conflict
              this.fileWatcher.addSyncWritePath(file.path);
              try {
                await this.frontmatterManager.markSynced(file);
              } finally {
                this.fileWatcher.removeSyncWritePath(file.path);
              }
              if (conflictData.content_hash && mapEntry) {
                mapEntry.contentHash = conflictData.content_hash;
              }
              await this.baseCache.saveBase(fm.sys_id, localBody);
              result.pushed++;
            } else {
              // Real conflict — attempt section merge with server ancestor
              const ancestorBody = conflictData.ancestor_content
                ? stripFrontmatter(conflictData.ancestor_content)
                : await this.baseCache.loadBase(fm.sys_id);

              const baseSections = ancestorBody ? parseSections(ancestorBody) : null;
              const localSections = parseSections(localBody);
              const remoteSections = parseSections(remoteBody);
              const mergeResult = mergeSections(baseSections, localSections, remoteSections);

              if (!mergeResult.hasConflicts) {
                // Auto-merge succeeded — write merged, will re-push next cycle
                this.fileWatcher.addSyncWritePath(file.path);
                try {
                  const merged = await this.rebuildWithFrontmatter(file, mergeResult.mergedBody);
                  await this.plugin.app.vault.modify(file, merged);
                  await this.frontmatterManager.markDirty(file);
                } finally {
                  this.fileWatcher.removeSyncWritePath(file.path);
                }
                await this.baseCache.saveBase(fm.sys_id, mergeResult.mergedBody);
                if (conflictData.content_hash && mapEntry) {
                  mapEntry.contentHash = conflictData.content_hash;
                }
              } else {
                this.conflictResolver.applyConflict({
                  sysId: fm.sys_id,
                  path: file.path,
                  remoteContent: conflictData.content,
                  remoteTimestamp: conflictData.sys_updated_on,
                  sectionConflicts: mergeResult.conflicts,
                  ancestorContent: conflictData.ancestor_content ?? undefined,
                });
                result.conflicts++;
              }
            }
          } else {
            // Fallback: old API without enhanced 409 body
            const latest = await this.apiClient.getDocument(fm.sys_id);
            if (latest.ok && latest.data) {
              const localBody = stripFrontmatter(content);
              const remoteBody = stripFrontmatter(latest.data.content);

              if (remoteBody === localBody) {
                this.fileWatcher.addSyncWritePath(file.path);
                try {
                  await this.frontmatterManager.markSynced(file);
                } finally {
                  this.fileWatcher.removeSyncWritePath(file.path);
                }
                await this.baseCache.saveBase(fm.sys_id, localBody);
                result.pushed++;
              } else {
                const ancestorBody = await this.baseCache.loadBase(fm.sys_id);
                const baseSections = ancestorBody ? parseSections(ancestorBody) : null;
                const localSections = parseSections(localBody);
                const remoteSections = parseSections(remoteBody);
                const mergeResult = mergeSections(baseSections, localSections, remoteSections);

                if (!mergeResult.hasConflicts) {
                  this.fileWatcher.addSyncWritePath(file.path);
                  try {
                    const merged = await this.rebuildWithFrontmatter(file, mergeResult.mergedBody);
                    await this.plugin.app.vault.modify(file, merged);
                    await this.frontmatterManager.markDirty(file);
                  } finally {
                    this.fileWatcher.removeSyncWritePath(file.path);
                  }
                  await this.baseCache.saveBase(fm.sys_id, mergeResult.mergedBody);
                } else {
                  this.conflictResolver.applyConflict({
                    sysId: fm.sys_id,
                    path: file.path,
                    remoteContent: latest.data.content,
                    remoteTimestamp: latest.data.sys_updated_on,
                    sectionConflicts: mergeResult.conflicts,
                  });
                  result.conflicts++;
                }
              }
            }
          }
        } else {
          result.errors.push(`Update failed for ${file.basename}: HTTP ${updateResult.status}`);
        }
        return null;
      }

      this.fileWatcher.addSyncWritePath(file.path);
      try {
        await this.frontmatterManager.markSynced(file);
      } finally {
        this.fileWatcher.removeSyncWritePath(file.path);
      }

      const entry = this.plugin.syncState.docMap[fm.sys_id];
      if (entry && updateResult.data) {
        entry.lastServerTimestamp = updateResult.data.sys_updated_on;
        if (updateResult.data.content_hash) {
          entry.contentHash = updateResult.data.content_hash;
        }
      }

      await this.baseCache.saveBase(fm.sys_id, stripFrontmatter(content));
      result.pushed++;
      return updateResult.data?.sys_updated_on ?? null;
    } else {
      let category = fm.category ?? "";
      let project = fm.project ?? "";
      let tags = fm.tags ?? "";

      if (!this.cachedMetadata) {
        const metaResponse = await this.apiClient.getMetadata();
        if (metaResponse.ok && metaResponse.data) {
          this.cachedMetadata = metaResponse.data;
        }
      }

      const snMeta = this.cachedMetadata ?? { categories: [], projects: [], tags: [] };
      const userInput = await promptNewDocMetadata(this.plugin.app, snMeta, file.basename, {
        category,
        project,
        tags,
      });

      if (!userInput) return null;
      category = userInput.category;
      project = userInput.project;
      tags = userInput.tags;

      await this.ensureMetadata();
      const createResult = await this.apiClient.createDocument({
        title: file.basename,
        content,
        category: this.resolveValue("categories", category),
        project: this.resolveValue("projects", project),
        tags,
      });

      if (!createResult.ok || !createResult.data) {
        result.errors.push(`Create failed for ${file.basename}: HTTP ${createResult.status}`);
        return null;
      }

      const newDoc = createResult.data;

      this.fileWatcher.addSyncWritePath(file.path);
      try {
        await this.frontmatterManager.write(file, {
          sys_id: newDoc.sys_id,
          category: newDoc.category,
          project: newDoc.project,
          tags: newDoc.tags,
          synced: true,
        });
      } finally {
        this.fileWatcher.removeSyncWritePath(file.path);
      }

      this.plugin.syncState.docMap[newDoc.sys_id] = {
        sysId: newDoc.sys_id,
        path: file.path,
        lastServerTimestamp: newDoc.sys_updated_on,
        contentHash: newDoc.content_hash ?? "",
      };

      await this.baseCache.saveBase(newDoc.sys_id, stripFrontmatter(content));
      result.pushed++;
      return newDoc.sys_updated_on;
    }
  }

  private resolveLabel(type: "projects" | "categories", value: string): string {
    if (!this.cachedMetadata || !value) return value ?? "";
    const entry = this.cachedMetadata[type].find((e) => e.value === value);
    return entry?.label ?? value;
  }

  private resolveValue(type: "projects" | "categories", input: string): string {
    if (!this.cachedMetadata || !input) return input;
    const byValue = this.cachedMetadata[type].find((e) => e.value === input);
    if (byValue) return input;
    const byLabel = this.cachedMetadata[type].find(
      (e) => e.label.toLowerCase() === input.toLowerCase()
    );
    return byLabel?.value ?? input;
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

    const category = doc.category ?? "";
    if (!category) {
      console.warn(`Snobby: skipping "${doc.title ?? doc.sys_id}" — no category assigned`);
      return;
    }

    const { folderMapping } = this.plugin.settings;

    await this.ensureMetadata();
    const rawProject = this.resolveLabel("projects", doc.project ?? "");
    let projectLabel = rawProject ? sanitizePathSegment(rawProject) : "";

    // Project-scoped categories with no project go to Uncategorized/
    if (!projectLabel && !isTopLevelCategory(folderMapping, category)) {
      projectLabel = "Uncategorized";
    }

    const filePath = normalizePath(
      resolveFilePath(folderMapping, doc.title ?? "Untitled", projectLabel, category, "")
    );

    const finalPath = this.resolveCollision(filePath, doc.sys_id);

    const parentDir = finalPath.substring(0, finalPath.lastIndexOf("/"));
    if (parentDir) {
      await this.ensureFolderExists(parentDir);
    }

    this.fileWatcher.addSyncWritePath(finalPath);
    try {
      await this.plugin.app.vault.create(finalPath, doc.content);

      const createdFile = this.plugin.app.vault.getAbstractFileByPath(finalPath);
      if (createdFile instanceof TFile) {
        await this.frontmatterManager.write(createdFile, {
          sys_id: doc.sys_id,
          category: doc.category,
          project: doc.project,
          tags: doc.tags,
          synced: true,
        });
      }
    } finally {
      this.fileWatcher.removeSyncWritePath(finalPath);
    }

    this.plugin.syncState.docMap[doc.sys_id] = {
      sysId: doc.sys_id,
      path: finalPath,
      lastServerTimestamp: doc.sys_updated_on,
      contentHash: doc.content_hash ?? "",
    };

    await this.baseCache.saveBase(doc.sys_id, stripFrontmatter(doc.content));
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

  resolveCollision(path: string, sysId: string): string {
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

  private async rebuildWithFrontmatter(file: TFile, newBody: string): Promise<string> {
    const raw = await this.plugin.app.vault.read(file);
    if (!raw.startsWith("---")) return newBody;
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx === -1) return newBody;
    return raw.substring(0, endIdx + 4) + "\n" + newBody;
  }

  private async getBodyContent(file: TFile): Promise<string> {
    const raw = await this.plugin.app.vault.read(file);
    return stripFrontmatter(raw);
  }

  private async getContentForPush(file: TFile): Promise<string> {
    const raw = await this.plugin.app.vault.read(file);
    if (!raw.startsWith("---")) return raw;
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx === -1) return raw;

    const fmBlock = raw.substring(4, endIdx);
    const body = raw.slice(endIdx + 4);
    const prefix = this.plugin.settings.frontmatterPrefix;

    const filteredLines = fmBlock.split("\n").filter((line) => {
      const match = line.match(/^(\S+)\s*:/);
      if (!match) return true;
      return !match[1]!.startsWith(prefix);
    });

    const hasContent = filteredLines.some((line) => line.trim().length > 0);
    if (!hasContent) {
      return body.replace(/^\n+/, "");
    }

    return "---\n" + filteredLines.join("\n") + "\n---" + body;
  }
}
