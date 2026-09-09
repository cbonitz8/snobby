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
import { stripFrontmatter, contentForPush, replaceBody } from "./frontmatter-format";
import { parseSections, serializeSections } from "./section-parser";
import { md5Hash } from "./content-hash";
import { reconcile } from "./reconciler";

function sanitizeErrorMsg(msg: string): string {
  return msg.split("\n")[0]!.slice(0, 200);
}

export async function computeLocalHash(
  vault: { read(file: TFile): Promise<string> },
  prefix: string,
  file: TFile
): Promise<string> {
  const pushable = await getContentForPush(vault, prefix, file);
  return md5Hash(pushable);
}

export async function getContentForPush(
  vault: { read(file: TFile): Promise<string> },
  prefix: string,
  file: TFile
): Promise<string> {
  const raw = await vault.read(file);
  return contentForPush(raw, prefix);
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
      await this.discoverNewDocs(result);
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
          await this.fileWatcher.duringSyncWrite(entry.path, () =>
            this.plugin.app.fileManager.trashFile(file),
          );
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
          const content = await this.getContentForPushInternal(file);

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

          await this.fileWatcher.duringSyncWrite(file.path, () =>
            this.frontmatterManager.write(file, {
              sys_id: newDoc.sys_id,
              synced: true,
            }),
          );

          this.plugin.syncState.docMap[newDoc.sys_id] = {
            sysId: newDoc.sys_id,
            path: file.path,
            lastServerTimestamp: newDoc.sys_updated_on,
            contentHash: newDoc.content_hash ?? "",
            localContentHash: await computeLocalHash(
              this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
            ),
            lastSyncMtime: file.stat.mtime,
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
          const content = await this.getContentForPushInternal(file);

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

          await this.fileWatcher.duringSyncWrite(file.path, () =>
            this.frontmatterManager.markSynced(file),
          );

          const entry = this.plugin.syncState.docMap[fm.sys_id!];
          if (entry) {
            if (updateResult.data?.sys_updated_on) {
              entry.lastServerTimestamp = updateResult.data.sys_updated_on;
            }
            if (updateResult.data?.content_hash) {
              entry.contentHash = updateResult.data.content_hash;
            }
            entry.localContentHash = await computeLocalHash(
              this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
            );
            entry.lastSyncMtime = file.stat.mtime;
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

      const prefix = this.plugin.settings.frontmatterPrefix;
      const vault = this.plugin.app.vault;
      const localHash = await computeLocalHash(vault, prefix, file);
      const localBody = await this.getBodyContent(file);
      const remoteBody = stripFrontmatter(doc.content);
      const cachedAncestor = await this.baseCache.loadBase(doc.sys_id);

      const outcome = reconcile({
        localBody,
        remoteBody,
        serverAncestor: null,
        cachedAncestor,
        remoteContentHash: doc.content_hash,
        storedContentHash: mapEntry.contentHash,
        storedLocalHash: mapEntry.localContentHash,
        localHash,
      });

      if (outcome.kind === "no-change") {
        // Server content unchanged — just advance the timestamp.
        mapEntry.lastServerTimestamp = doc.sys_updated_on;
        return;
      }

      if (outcome.kind === "overwrite-local") {
        // Local is clean — overwrite with remote.
        const fm = this.frontmatterManager.read(file);
        await this.fileWatcher.duringSyncWrite(file.path, async () => {
          await this.plugin.app.vault.modify(file, doc.content);
          await this.frontmatterManager.write(file, {
            sys_id: fm.sys_id,
            category: fm.category,
            project: fm.project,
            tags: fm.tags,
            synced: true,
          });
        });
        await this.baseCache.saveBase(doc.sys_id, remoteBody);
        mapEntry.lastServerTimestamp = doc.sys_updated_on;
        mapEntry.contentHash = doc.content_hash ?? "";
        mapEntry.localContentHash = await computeLocalHash(vault, prefix, file);
        mapEntry.lastSyncMtime = file.stat.mtime;
        result.pulled++;
        return;
      }

      if (outcome.kind === "auto-merged") {
        const fm = this.frontmatterManager.read(file);
        await this.fileWatcher.duringSyncWrite(file.path, async () => {
          const merged = await this.rebuildWithFrontmatter(file, outcome.mergedBody);
          await this.plugin.app.vault.modify(file, merged);
          await this.frontmatterManager.write(file, { ...fm, synced: false });
        });
        await this.baseCache.saveBase(doc.sys_id, outcome.mergedBody);
        mapEntry.lastServerTimestamp = doc.sys_updated_on;
        mapEntry.contentHash = doc.content_hash ?? "";
        // Do NOT update localContentHash/lastSyncMtime — merged content needs re-push
        result.pulled++;
        return;
      }

      // outcome.kind === "conflict"
      this.conflictResolver.applyConflict({
        sysId: doc.sys_id,
        path: mapEntry.path,
        remoteContent: doc.content,
        remoteTimestamp: doc.sys_updated_on,
        sectionConflicts: outcome.sectionConflicts,
      });
      result.conflicts++;
    } else {
      await this.createLocalFile(doc);
      result.pulled++;
    }
  }

  private async push(result: SyncResult): Promise<string | null> {
    let latestTs: string | null = null;
    const vault = this.plugin.app.vault;
    const prefix = this.plugin.settings.frontmatterPrefix;

    // Part 1: Iterate docMap entries (existing tracked files)
    for (const [sysId, entry] of Object.entries(this.plugin.syncState.docMap)) {
      if (this.plugin.syncState.conflicts[sysId]) continue;

      const file = vault.getAbstractFileByPath(entry.path);
      if (!(file instanceof TFile)) continue;
      if (this.fileWatcher.isExcluded(file.path)) continue;

      // Fast mtime check
      if (entry.lastSyncMtime !== undefined && file.stat.mtime <= entry.lastSyncMtime) continue;

      // Compute hash
      const localHash = await computeLocalHash(vault, prefix, file);

      // Compare against stored hash
      if (entry.localContentHash !== undefined && localHash === entry.localContentHash) continue;

      // Legacy migration: no localContentHash — backfill and skip.
      // Local and server hashes use different normalization so direct comparison is unreliable.
      // The pull phase handles server→local changes; here we just establish the baseline.
      if (entry.localContentHash === undefined) {
        entry.localContentHash = localHash;
        entry.lastSyncMtime = file.stat.mtime;
        continue;
      }

      try {
        const pushTs = await this.handlePushFile(file, result);
        if (pushTs && (!latestTs || pushTs > latestTs)) latestTs = pushTs;
        this.plugin.updateSyncProgress(result.pulled, result.pushed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Push error for ${file.name}: ${msg}`);
      }
    }

    // Part 2: Scan for new files (sn_category set, no sn_sys_id)
    const allFiles = vault.getMarkdownFiles();
    for (const file of allFiles) {
      if (this.fileWatcher.isExcluded(file.path)) continue;
      const fm = this.frontmatterManager.read(file);
      if (fm.category && !fm.sys_id) {
        try {
          const pushTs = await this.handlePushFile(file, result);
          if (pushTs && (!latestTs || pushTs > latestTs)) latestTs = pushTs;
          this.plugin.updateSyncProgress(result.pulled, result.pushed);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Push error for ${file.name}: ${msg}`);
        }
      }
    }

    this.skipPullSysIds.clear();
    return latestTs;
  }

  private async discoverNewDocs(result: SyncResult): Promise<void> {
    const response = await this.apiClient.getDocuments();
    if (!response.ok || !response.data) return;

    const docs = Array.isArray(response.data) ? response.data : [response.data];
    const docMap = this.plugin.syncState.docMap;
    const ignoredIds = this.plugin.syncState.ignoredIds;

    for (const doc of docs) {
      if (docMap[doc.sys_id] || ignoredIds.includes(doc.sys_id)) continue;

      try {
        await this.createLocalFile(doc);
        result.pulled++;
        this.plugin.updateSyncProgress(result.pulled, result.pushed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`Download error for ${doc.title}: ${sanitizeErrorMsg(msg)}`);
      }
    }
  }

  private async handlePushFile(file: TFile, result: SyncResult): Promise<string | null> {
    const fm = this.frontmatterManager.read(file);
    const content = await this.getContentForPushInternal(file);

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
              await this.fileWatcher.duringSyncWrite(file.path, () =>
                this.frontmatterManager.markSynced(file),
              );
              if (conflictData.content_hash && mapEntry) {
                mapEntry.contentHash = conflictData.content_hash;
              }
              if (mapEntry) {
                mapEntry.localContentHash = await computeLocalHash(
                  this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
                );
                mapEntry.lastSyncMtime = file.stat.mtime;
              }
              await this.baseCache.saveBase(fm.sys_id, localBody);
              result.pushed++;
            } else {
              // Real conflict — reconcile against the server ancestor (else the cache).
              const serverAncestor = conflictData.ancestor_content
                ? stripFrontmatter(conflictData.ancestor_content)
                : null;
              const cachedAncestor =
                serverAncestor === null ? await this.baseCache.loadBase(fm.sys_id) : null;
              const outcome = reconcile({
                localBody,
                remoteBody,
                serverAncestor,
                cachedAncestor,
                localAlreadyDiverged: true,
              });

              if (outcome.kind === "auto-merged") {
                // Auto-merge succeeded — write merged, will re-push next cycle
                await this.fileWatcher.duringSyncWrite(file.path, async () => {
                  const merged = await this.rebuildWithFrontmatter(file, outcome.mergedBody);
                  await this.plugin.app.vault.modify(file, merged);
                  await this.frontmatterManager.markDirty(file);
                });
                await this.baseCache.saveBase(fm.sys_id, outcome.mergedBody);
                if (conflictData.content_hash && mapEntry) {
                  mapEntry.contentHash = conflictData.content_hash;
                }
              } else if (outcome.kind === "conflict") {
                this.conflictResolver.applyConflict({
                  sysId: fm.sys_id,
                  path: file.path,
                  remoteContent: conflictData.content,
                  remoteTimestamp: conflictData.sys_updated_on,
                  sectionConflicts: outcome.sectionConflicts,
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
                await this.fileWatcher.duringSyncWrite(file.path, () =>
                  this.frontmatterManager.markSynced(file),
                );
                const fallbackEntry = this.plugin.syncState.docMap[fm.sys_id];
                if (fallbackEntry) {
                  fallbackEntry.localContentHash = await computeLocalHash(
                    this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
                  );
                  fallbackEntry.lastSyncMtime = file.stat.mtime;
                }
                await this.baseCache.saveBase(fm.sys_id, localBody);
                result.pushed++;
              } else {
                const cachedAncestor = await this.baseCache.loadBase(fm.sys_id);
                const outcome = reconcile({
                  localBody,
                  remoteBody,
                  serverAncestor: null,
                  cachedAncestor,
                  localAlreadyDiverged: true,
                });

                if (outcome.kind === "auto-merged") {
                  await this.fileWatcher.duringSyncWrite(file.path, async () => {
                    const merged = await this.rebuildWithFrontmatter(file, outcome.mergedBody);
                    await this.plugin.app.vault.modify(file, merged);
                    await this.frontmatterManager.markDirty(file);
                  });
                  await this.baseCache.saveBase(fm.sys_id, outcome.mergedBody);
                } else if (outcome.kind === "conflict") {
                  this.conflictResolver.applyConflict({
                    sysId: fm.sys_id,
                    path: file.path,
                    remoteContent: latest.data.content,
                    remoteTimestamp: latest.data.sys_updated_on,
                    sectionConflicts: outcome.sectionConflicts,
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

      await this.fileWatcher.duringSyncWrite(file.path, () =>
        this.frontmatterManager.markSynced(file),
      );

      // Self-heal: duplicate server records can leave docMap keyed under a
      // sys_id the file no longer carries; the baseline below would then miss
      // and the entry re-pushes forever. Repoint/remove any other key for this path.
      const docMap = this.plugin.syncState.docMap;
      for (const [key, staleEntry] of Object.entries(docMap)) {
        if (key !== fm.sys_id && staleEntry.path === file.path) {
          if (!docMap[fm.sys_id]) {
            staleEntry.sysId = fm.sys_id;
            docMap[fm.sys_id] = staleEntry;
          }
          delete docMap[key];
        }
      }

      const entry = docMap[fm.sys_id];
      if (entry && updateResult.data) {
        entry.lastServerTimestamp = updateResult.data.sys_updated_on;
        if (updateResult.data.content_hash) {
          entry.contentHash = updateResult.data.content_hash;
        }
        entry.localContentHash = await computeLocalHash(
          this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
        );
        entry.lastSyncMtime = file.stat.mtime;
      }

      await this.baseCache.saveBase(fm.sys_id, stripFrontmatter(content));
      result.pushed++;
      return updateResult.data?.sys_updated_on ?? null;
    } else {
      let category = fm.category ?? "";
      let project = fm.project ?? "";
      let tags = fm.tags ?? "";

      const needsPrompt = !category || category === "template";
      if (needsPrompt) {
        if (!this.cachedMetadata) {
          const metaResponse = await this.apiClient.getMetadata();
          if (metaResponse.ok && metaResponse.data) {
            this.cachedMetadata = metaResponse.data;
          }
        }

        const snMeta = this.cachedMetadata ?? { categories: [], projects: [], tags: [] };
        const userInput = await promptNewDocMetadata(this.plugin.app, snMeta, file.basename, {
          category: category === "template" ? "" : category,
          project,
          tags,
        });

        if (!userInput) return null;
        category = userInput.category;
        project = userInput.project;
        tags = userInput.tags;
      }

      // Check for existing server doc with same title+category+project before creating
      const existingDoc = await this.findExistingServerDoc(file.basename, category, project, result);
      if (existingDoc) {
        return this.adoptAndMergeDoc(file, existingDoc, content, result);
      }

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

      await this.fileWatcher.duringSyncWrite(file.path, () =>
        this.frontmatterManager.write(file, {
          sys_id: newDoc.sys_id,
          category: newDoc.category,
          project: newDoc.project,
          tags: newDoc.tags,
          synced: true,
        }),
      );

      this.plugin.syncState.docMap[newDoc.sys_id] = {
        sysId: newDoc.sys_id,
        path: file.path,
        lastServerTimestamp: newDoc.sys_updated_on,
        contentHash: newDoc.content_hash ?? "",
        localContentHash: await computeLocalHash(
          this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
        ),
        lastSyncMtime: file.stat.mtime,
      };

      await this.baseCache.saveBase(newDoc.sys_id, stripFrontmatter(content));
      result.pushed++;
      return newDoc.sys_updated_on;
    }
  }

  /**
   * Find the server doc this local file should be adopted into, or null to create.
   *
   * Title+category alone is not an identity: many projects carry a note with the
   * same title and category (one `_overview` per project), so matching without the
   * project adopts an arbitrary twin and merges two projects' notes together.
   * Frontmatter may hold either the choice value or its label, so both sides are
   * normalised to values before comparing.
   */
  private async findExistingServerDoc(
    title: string,
    category: string,
    project: string,
    result: SyncResult,
  ): Promise<SNDocument | null> {
    const response = await this.apiClient.getDocuments();
    if (!response.ok || !response.data) return null;
    const docs = Array.isArray(response.data) ? response.data : [response.data];

    // Normalisation needs the choice lists; without them resolveValue is a no-op
    // and comparison silently falls back to raw strings.
    await this.ensureMetadata();
    const wantCategory = this.resolveValue("categories", category);
    const wantProject = this.resolveValue("projects", project);

    const sameTitle = docs.filter(
      (d) => d.title === title && this.resolveValue("categories", d.category) === wantCategory
    );
    if (sameTitle.length === 0) return null;

    if (wantProject) {
      return sameTitle.find((d) => this.resolveValue("projects", d.project) === wantProject) ?? null;
    }

    // The local note names no project, so there is nothing to disambiguate with.
    // Adopting one of several twins would push a merge into some other project's
    // doc — destructive and unrecoverable; a duplicate row is neither.
    if (sameTitle.length > 1) {
      result.errors.push(
        `Ambiguous adopt for ${title}: ${sameTitle.length} server docs share category ` +
        `"${wantCategory}" across projects (${sameTitle.map((d) => d.project || "(none)").join(", ")}). ` +
        `Set the project in frontmatter to pick one; created a new doc instead.`
      );
      return null;
    }

    return sameTitle[0] ?? null;
  }

  private async adoptAndMergeDoc(
    file: TFile,
    serverDoc: SNDocument,
    localContent: string,
    result: SyncResult
  ): Promise<string | null> {
    const localBody = stripFrontmatter(localContent);
    const remoteBody = stripFrontmatter(serverDoc.content);

    // Combine sections: start with server's, overlay local (adds new user sections)
    const remoteSections = parseSections(remoteBody);
    const localSections = parseSections(localBody);
    const merged = new Map(remoteSections);
    for (const [key, section] of localSections) {
      merged.set(key, section);
    }
    const mergedBody = serializeSections(merged);

    // Rebuild pushable content with server's non-sn frontmatter + merged body
    const pushContent = replaceBody(serverDoc.content, mergedBody);

    // Push as UPDATE to existing server doc
    const updateResult = await this.apiClient.updateDocument(serverDoc.sys_id, {
      content: pushContent,
      title: file.basename,
      expected_hash: serverDoc.content_hash,
    });

    if (!updateResult.ok) {
      if (updateResult.status === 409) {
        // Server changed since we read it — fall back to normal create
        // (next sync will reconcile via merge)
        result.errors.push(`Standup adopt conflict for ${file.basename} — will retry next sync`);
      } else {
        result.errors.push(`Adopt failed for ${file.basename}: HTTP ${updateResult.status}`);
      }
      return null;
    }

    // Update local file with merged content + server's sys_id
    await this.fileWatcher.duringSyncWrite(file.path, async () => {
      const merged = await this.rebuildWithFrontmatter(file, mergedBody);
      await this.plugin.app.vault.modify(file, merged);
      await this.frontmatterManager.write(file, {
        sys_id: serverDoc.sys_id,
        category: serverDoc.category,
        project: serverDoc.project,
        tags: serverDoc.tags,
        synced: true,
      });
    });

    this.plugin.syncState.docMap[serverDoc.sys_id] = {
      sysId: serverDoc.sys_id,
      path: file.path,
      lastServerTimestamp: updateResult.data?.sys_updated_on ?? serverDoc.sys_updated_on,
      contentHash: updateResult.data?.content_hash ?? serverDoc.content_hash ?? "",
      localContentHash: await computeLocalHash(
        this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file
      ),
      lastSyncMtime: file.stat.mtime,
    };

    await this.baseCache.saveBase(serverDoc.sys_id, mergedBody);
    result.pushed++;
    return updateResult.data?.sys_updated_on ?? null;
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

    const categoryLabel = this.resolveLabel("categories", category);
    const filePath = normalizePath(
      resolveFilePath(folderMapping, doc.title ?? "Untitled", projectLabel, category, "", categoryLabel)
    );

    const finalPath = this.resolveCollision(filePath, doc.sys_id);

    const parentDir = finalPath.substring(0, finalPath.lastIndexOf("/"));
    if (parentDir) {
      await this.ensureFolderExists(parentDir);
    }

    await this.fileWatcher.duringSyncWrite(finalPath, async () => {
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
    });

    const createdFileRef = this.plugin.app.vault.getAbstractFileByPath(finalPath);
    this.plugin.syncState.docMap[doc.sys_id] = {
      sysId: doc.sys_id,
      path: finalPath,
      lastServerTimestamp: doc.sys_updated_on,
      contentHash: doc.content_hash ?? "",
      localContentHash: createdFileRef instanceof TFile
        ? await computeLocalHash(this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, createdFileRef)
        : undefined,
      lastSyncMtime: createdFileRef instanceof TFile ? createdFileRef.stat.mtime : undefined,
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
    return replaceBody(raw, newBody);
  }

  private async getBodyContent(file: TFile): Promise<string> {
    const raw = await this.plugin.app.vault.read(file);
    return stripFrontmatter(raw);
  }

  private async getContentForPushInternal(file: TFile): Promise<string> {
    return getContentForPush(this.plugin.app.vault, this.plugin.settings.frontmatterPrefix, file);
  }
}
