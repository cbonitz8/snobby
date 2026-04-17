import { ItemView, WorkspaceLeaf, Notice, Menu, TFile, Modal, Setting } from "obsidian";
import type SNSyncPlugin from "./main";
import type { SNDocument, SNMetadata, ConflictEntry } from "./types";
import { computeSideBySide, computeDiff, extractSideBySideHunks, extractChangeGroups, type DiffLine } from "./diff";
import { stripFrontmatter } from "./frontmatter-manager";

export const VIEW_TYPE_SN_BROWSER = "sn-document-browser";

export class SNBrowserView extends ItemView {
  private plugin: SNSyncPlugin;
  private activeTab: "browse" | "settings" = "browse";
  private serverDocs: SNDocument[] = [];
  private metadata: SNMetadata | null = null;
  private isLoading = false;
  private selectedProject = "";
  private selectedCategory = "";
  private selectedStatus = "";
  private searchQuery = "";
  private selectedDocIds: Set<string> = new Set();
  private selectedTreeNode: string = "";
  private expandedNodes: Set<string> = new Set();
  private viewMode: "triage" | "drill-in" = "triage";
  private drillInSysId: string | null = null;
  private perSectionChoices: Map<string, Map<string, "local" | "remote">> = new Map();
  private hunkChoices: Map<string, Map<string, Map<number, "local" | "remote">>> = new Map();
  private lineChoices: Map<string, Map<string, Map<number, boolean>>> = new Map();

  constructor(leaf: WorkspaceLeaf, plugin: SNSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SN_BROWSER;
  }

  getDisplayText(): string {
    return "Snobby browser";
  }

  getIcon(): string {
    return "cloud";
  }

  async onOpen() {
    await this.render();
  }

  async showConflict(sysId: string) {
    this.activeTab = "settings";
    this.drillInSysId = sysId;
    this.viewMode = "drill-in";
    await this.render();
  }

  async onClose() {}

  async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("sn-browser");

    const tabBar = container.createDiv({ cls: "sn-browser-tabs" });
    const browseTab = tabBar.createEl("button", {
      text: "Browse SN",
      cls: `sn-browser-tab ${this.activeTab === "browse" ? "is-active" : ""}`,
    });
    const conflictCount = Object.keys(this.plugin.syncState.conflicts).length;
    const settingsLabel = conflictCount > 0 ? `Sync settings (${conflictCount})` : "Sync settings";
    const settingsTab = tabBar.createEl("button", {
      text: settingsLabel,
      cls: `sn-browser-tab ${this.activeTab === "settings" ? "is-active" : ""}`,
    });

    browseTab.addEventListener("click", () => {
      this.activeTab = "browse";
      void this.render();
    });
    settingsTab.addEventListener("click", () => {
      this.activeTab = "settings";
      void this.render();
    });

    const content = container.createDiv({ cls: "sn-browser-content" });

    if (this.activeTab === "browse") {
      await this.renderBrowseTab(content);
    } else {
      this.renderSettingsTab(content);
    }
  }

  private async fetchData() {
    if (this.isLoading || this.serverDocs.length > 0) return;
    this.isLoading = true;

    const [docsResponse, metaResponse] = await Promise.all([
      this.plugin.apiClient.getDocuments(),
      this.plugin.apiClient.getMetadata(),
    ]);

    if (docsResponse.ok && docsResponse.data) {
      this.serverDocs = Array.isArray(docsResponse.data)
        ? docsResponse.data
        : [docsResponse.data];
    }
    if (metaResponse.ok && metaResponse.data) {
      this.metadata = metaResponse.data;
    }

    this.isLoading = false;

    await this.reconcileDocMap();
  }

  private async reconcileDocMap() {
    const allFiles = this.plugin.app.vault.getMarkdownFiles();
    const docMap = this.plugin.syncState.docMap;
    const trackedIds = new Set(Object.keys(docMap));
    let added = 0;

    for (const file of allFiles) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;

      const prefix = this.plugin.settings.frontmatterPrefix;
      const sysId = fm[`${prefix}sys_id`];
      if (!sysId || trackedIds.has(sysId)) continue;

      docMap[sysId] = {
        sysId,
        path: file.path,
        lastServerTimestamp: "",
        contentHash: "",
      };
      trackedIds.add(sysId);
      added++;
    }

    if (added > 0) {
      await this.plugin.saveSettings();

    }
  }


  private createStatCard(container: HTMLElement, value: string, label: string, warning = false) {
    const card = container.createDiv({ cls: "sn-stat" });
    card.createEl("span", { text: value, cls: `sn-stat-value${warning ? " sn-stat-warning" : ""}` });
    card.createEl("span", { text: label, cls: "sn-stat-label" });
  }

  private getDocStatus(doc: SNDocument): string {
    const entry = this.plugin.syncState.docMap[doc.sys_id];
    if (!entry) return "not-downloaded";
    const file = this.plugin.app.vault.getAbstractFileByPath(entry.path);
    if (!file) return "not-downloaded";
    return "synced";
  }

  private getFilteredDocs(): SNDocument[] {
    return this.serverDocs.filter((doc) => {
      if (this.selectedProject && doc.project !== this.selectedProject) return false;
      if (this.selectedCategory && doc.category !== this.selectedCategory) return false;
      if (this.selectedStatus) {
        const status = this.getDocStatus(doc);
        if (this.selectedStatus !== status) return false;
      }
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        if (!doc.title.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  private async renderBrowseTab(container: HTMLElement) {
    await this.fetchData();

    if (this.isLoading) {
      container.createEl("p", { text: "Loading documents from ServiceNow...", cls: "sn-browser-loading" });
      return;
    }

    if (this.serverDocs.length === 0) {
      container.createEl("p", { text: "No documents found. Check your connection settings." });
      return;
    }

    const filterBar = container.createDiv({ cls: "sn-filter-bar" });

    const projectSelect = filterBar.createEl("select", { cls: "sn-filter-select" });
    projectSelect.createEl("option", { text: "All projects", value: "" });
    if (this.metadata) {
      for (const proj of this.metadata.projects) {
        const opt = projectSelect.createEl("option", { text: proj.label, value: proj.value });
        if (this.selectedProject === proj.value) opt.selected = true;
      }
    }
    projectSelect.addEventListener("change", () => {
      this.selectedProject = projectSelect.value;
      void this.render();
    });

    const categorySelect = filterBar.createEl("select", { cls: "sn-filter-select" });
    categorySelect.createEl("option", { text: "All categories", value: "" });
    if (this.metadata) {
      for (const cat of this.metadata.categories) {
        const opt = categorySelect.createEl("option", { text: cat.label, value: cat.value });
        if (this.selectedCategory === cat.value) opt.selected = true;
      }
    }
    categorySelect.addEventListener("change", () => {
      this.selectedCategory = categorySelect.value;
      void this.render();
    });

    const statusSelect = filterBar.createEl("select", { cls: "sn-filter-select" });
    statusSelect.createEl("option", { text: "All status", value: "" });
    statusSelect.createEl("option", { text: "Synced", value: "synced" });
    statusSelect.createEl("option", { text: "Not downloaded", value: "not-downloaded" });
    statusSelect.value = this.selectedStatus;
    statusSelect.addEventListener("change", () => {
      this.selectedStatus = statusSelect.value;
      void this.render();
    });

    const searchInput = filterBar.createEl("input", {
      type: "text",
      placeholder: "Search by title...",
      cls: "sn-filter-search",
      value: this.searchQuery,
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      void this.render();
    });

    const refreshBtn = filterBar.createEl("button", { text: "↻", cls: "sn-filter-refresh" });
    refreshBtn.addEventListener("click", () => {
      this.serverDocs = [];
      this.metadata = null;
      void this.render();
    });

    const panes = container.createDiv({ cls: "sn-browser-panes" });
    this.renderTree(panes);
    this.renderDocList(panes);
  }

  private renderSettingsTab(container: HTMLElement) {
    const stats = container.createDiv({ cls: "sn-sync-stats" });
    const totalServer = this.serverDocs.length;
    const totalLocal = Object.keys(this.plugin.syncState.docMap).length;
    const excludeCount = this.plugin.settings.excludePaths.length;

    const conflicts = this.plugin.conflictResolver.getAllConflicts();

    stats.createEl("h3", { text: "Sync overview" });
    const statGrid = stats.createDiv({ cls: "sn-stat-grid" });
    this.createStatCard(statGrid, String(totalServer), "On server");
    this.createStatCard(statGrid, String(totalLocal), "Downloaded");
    this.createStatCard(statGrid, String(excludeCount), "Excluded paths");
    this.createStatCard(statGrid, String(conflicts.length), "Conflicts", conflicts.length > 0);

    const dangerSection = container.createDiv({ cls: "sn-exclude-section" });
    dangerSection.createEl("h3", { text: "Reset & re-pull" });
    dangerSection.createEl("p", {
      text: "Delete all synced files and re-download from ServiceNow. Use after changing folder mapping or to fix misplaced files.",
      cls: "sn-exclude-desc",
    });
    const repullBtn = dangerSection.createEl("button", {
      text: "Delete all & re-pull",
      cls: "sn-action-btn sn-action-btn-danger",
    });
    repullBtn.addEventListener("click", () => {
      const count = Object.keys(this.plugin.syncState.docMap).length;
      if (count === 0) {
        new Notice("No synced files to delete.");
        return;
      }
      const modal = new ConfirmModal(
        this.plugin.app,
        `This will delete ${count} local synced file${count > 1 ? "s" : ""} and re-download them from ServiceNow using the current folder mapping.\n\nLocal-only files (not yet pushed) will NOT be affected.`,
        () => {
          void (async () => {
            repullBtn.setText("Deleting & re-pulling...");
            repullBtn.setAttr("disabled", "true");
            await this.plugin.syncEngine.deleteAllAndRepull();
            this.serverDocs = [];
            this.metadata = null;
            await this.render();
          })();
        }
      );
      modal.open();
    });

    const conflictSection = container.createDiv({ cls: "sn-conflict-section" });
    conflictSection.createEl("h3", { text: "Conflicts" });

    if (conflicts.length === 0) {
      conflictSection.createEl("p", { text: "No conflicts.", cls: "sn-conflict-empty" });
    } else if (this.viewMode === "drill-in" && this.drillInSysId) {
      const conflict = this.plugin.syncState.conflicts[this.drillInSysId];
      if (conflict) {
        this.renderDrillIn(conflictSection, conflict);
      } else {
        this.viewMode = "triage";
        this.drillInSysId = null;
        this.renderTriageList(conflictSection, conflicts);
      }
    } else {
      this.renderTriageList(conflictSection, conflicts);
    }

    const excludeSection = container.createDiv({ cls: "sn-exclude-section" });
    excludeSection.createEl("h3", { text: "Excluded from sync" });
    excludeSection.createEl("p", {
      text: "Files and folders matching these patterns will not be synced to ServiceNow.",
      cls: "sn-exclude-desc",
    });

    const addRow = excludeSection.createDiv({ cls: "sn-exclude-add" });
    const addInput = addRow.createEl("input", {
      type: "text",
      placeholder: "Folder path or pattern (e.g., Templates/ or *.canvas)",
      cls: "sn-exclude-input",
    });
    const addBtn = addRow.createEl("button", { text: "Add", cls: "sn-action-btn mod-cta" });
    addBtn.addEventListener("click", () => {
      void (async () => {
        const value = addInput.value.trim();
        if (!value) return;
        if (!this.plugin.settings.excludePaths.includes(value)) {
          this.plugin.settings.excludePaths.push(value);
          await this.plugin.saveSettings();
        }
        addInput.value = "";
        await this.render();
      })();
    });

    const list = excludeSection.createDiv({ cls: "sn-exclude-list" });
    if (this.plugin.settings.excludePaths.length === 0) {
      list.createEl("p", { text: "No exclusions configured.", cls: "sn-exclude-empty" });
    } else {
      for (const path of this.plugin.settings.excludePaths) {
        const row = list.createDiv({ cls: "sn-exclude-row" });
        row.createEl("span", { text: path, cls: "sn-exclude-path" });
        const removeBtn = row.createEl("button", { text: "✕", cls: "sn-exclude-remove" });
        removeBtn.addEventListener("click", () => {
          void (async () => {
            this.plugin.settings.excludePaths = this.plugin.settings.excludePaths.filter((p) => p !== path);
            await this.plugin.saveSettings();
            await this.render();
          })();
        });
      }
    }
  }

  private renderDrillIn(container: HTMLElement, conflict: ConflictEntry) {
    const drillIn = container.createDiv({ cls: "sn-drill-in" });

    // Header with back button
    const header = drillIn.createDiv({ cls: "sn-drill-in-header" });
    const backBtn = header.createEl("button", { text: "← back", cls: "sn-drill-in-back" });
    backBtn.addEventListener("click", () => {
      this.viewMode = "triage";
      this.drillInSysId = null;
      void this.render();
    });
    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    header.createEl("span", { text: fileName, cls: "sn-drill-in-filename" });

    // Metadata
    const meta = drillIn.createDiv({ cls: "sn-drill-in-meta" });
    if (conflict.remoteTimestamp) {
      const remoteMtime = new Date(conflict.remoteTimestamp.replace(" ", "T"));
      const remoteTimeStr = isNaN(remoteMtime.getTime())
        ? conflict.remoteTimestamp
        : remoteMtime.toLocaleString();
      meta.createEl("span", { text: `Remote modified: ${remoteTimeStr}` });
    }

    const sc = conflict.sectionConflicts;
    const hasSections = sc && sc.length > 0;

    if (hasSections) {
      // Render each conflicting section with per-line interactive diff
      for (const s of sc) {
        const sectionBlock = drillIn.createDiv({ cls: "sn-drill-in-section" });

        const sectionHeader = sectionBlock.createDiv({ cls: "sn-drill-in-section-header" });
        const rawName = s.heading.replace(/^###\s*/, "");
        const name = rawName || "Document body";
        sectionHeader.createEl("span", { text: name });

        // Render interactive diff (returns flat diff lines for button handlers)
        const diffLines = this.renderInteractiveDiff(sectionBlock, conflict.sysId, s.key, s.localBody, s.remoteBody);
        const sectionLineChoices = this.getOrCreateLineChoices(conflict.sysId, s.key);

        // Section-level shortcut buttons
        const sectionBtns = sectionHeader.createDiv({ cls: "sn-drill-in-section-btns" });

        const allRemovedTrue = diffLines.every((l, i) => l.type !== "removed" || sectionLineChoices.get(i) === true);
        const allAddedFalse = diffLines.every((l, i) => l.type !== "added" || sectionLineChoices.get(i) === false);
        const allRemovedFalse = diffLines.every((l, i) => l.type !== "removed" || sectionLineChoices.get(i) === false);
        const allAddedTrue = diffLines.every((l, i) => l.type !== "added" || sectionLineChoices.get(i) === true);
        const allNonCtxTrue = diffLines.every((l, i) => l.type === "context" || sectionLineChoices.get(i) === true);
        const isAllLocal = allRemovedTrue && allAddedFalse;
        const isAllRemote = allRemovedFalse && allAddedTrue;
        const isAllBoth = allNonCtxTrue;

        const remoteBtn = sectionBtns.createEl("button", {
          text: "All remote",
          cls: `sn-conflict-quick-btn ${isAllRemote ? "is-chosen" : ""}`,
        });
        remoteBtn.addEventListener("click", () => {
          for (let i = 0; i < diffLines.length; i++) {
            if (diffLines[i]!.type === "removed") sectionLineChoices.set(i, false);
            else if (diffLines[i]!.type === "added") sectionLineChoices.set(i, true);
          }
          void this.render();
        });

        const bothBtn = sectionBtns.createEl("button", {
          text: "Include both",
          cls: `sn-conflict-quick-btn ${isAllBoth ? "is-chosen" : ""}`,
        });
        bothBtn.addEventListener("click", () => {
          for (let i = 0; i < diffLines.length; i++) {
            if (diffLines[i]!.type !== "context") sectionLineChoices.set(i, true);
          }
          void this.render();
        });

        const localBtn = sectionBtns.createEl("button", {
          text: "All local",
          cls: `sn-conflict-quick-btn ${isAllLocal ? "is-chosen" : ""}`,
        });
        localBtn.addEventListener("click", () => {
          for (let i = 0; i < diffLines.length; i++) {
            if (diffLines[i]!.type === "removed") sectionLineChoices.set(i, true);
            else if (diffLines[i]!.type === "added") sectionLineChoices.set(i, false);
          }
          void this.render();
        });
      }

      // Apply merge button
      const actions = drillIn.createDiv({ cls: "sn-drill-in-actions" });
      const applyBtn = actions.createEl("button", {
        text: "Apply merge",
        cls: "sn-action-btn mod-cta",
      });
      applyBtn.addEventListener("click", () => {
        void (async () => {
          const allChoices = this.lineChoices.get(conflict.sysId) ?? new Map();
          await this.plugin.conflictResolver.resolveWithLineChoices(conflict.sysId, allChoices);
          this.lineChoices.delete(conflict.sysId);
          this.viewMode = "triage";
          this.drillInSysId = null;
          await this.render();
        })();
      });
    } else {
      // Whole-file fallback: single side-by-side diff
      const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
      if (file instanceof TFile) {
        void (async () => {
          const rawLocal = await this.plugin.app.vault.read(file);
          const localBody = stripFrontmatter(rawLocal);
          const remoteBody = stripFrontmatter(conflict.remoteContent);
          this.renderSideBySide(drillIn, localBody, remoteBody);

          const actions = drillIn.createDiv({ cls: "sn-drill-in-actions" });
          const pullBtn = actions.createEl("button", { text: "Accept remote", cls: "sn-action-btn mod-cta" });
          pullBtn.addEventListener("click", () => {
            void (async () => {
              await this.plugin.conflictResolver.resolveWithPull(conflict.sysId);
              this.viewMode = "triage";
              this.drillInSysId = null;
              await this.render();
            })();
          });
          const pushBtn = actions.createEl("button", { text: "Keep local", cls: "sn-action-btn" });
          pushBtn.addEventListener("click", () => {
            void (async () => {
              await this.plugin.conflictResolver.resolveWithPush(conflict.sysId);
              this.viewMode = "triage";
              this.drillInSysId = null;
              await this.render();
            })();
          });
        })();
      }
    }
  }

  private renderSideBySide(container: HTMLElement, localBody: string, remoteBody: string) {
    const allLines = computeSideBySide(localBody, remoteBody);

    if (allLines.length === 0) {
      container.createEl("p", { text: "Contents are identical.", cls: "sn-conflict-empty" });
      return;
    }

    const hunks = extractSideBySideHunks(allLines);

    // Legend
    const legend = container.createDiv({ cls: "sn-diff-legend" });
    legend.createEl("span", { text: "Unique to this side", cls: "sn-diff-legend-item sn-diff-legend-included" });

    const grid = container.createDiv({ cls: "sn-side-by-side" });

    // Column headers
    grid.createDiv({ cls: "sn-side-by-side-header", text: "Local (Obsidian)" });
    grid.createDiv({ cls: "sn-side-by-side-header", text: "Remote (ServiceNow)" });

    for (let h = 0; h < hunks.length; h++) {
      if (h > 0) {
        grid.createDiv({ cls: "sn-side-by-side-cell sn-diff-separator", text: "\u22EF" });
        grid.createDiv({ cls: "sn-side-by-side-cell sn-diff-separator", text: "\u22EF" });
      }
      for (const line of hunks[h]!.lines) {
        const leftType = line.left?.type === "context" ? "context" : (line.left ? "included" : "empty");
        const rightType = line.right?.type === "context" ? "context" : (line.right ? "included" : "empty");

        grid.createDiv({ cls: `sn-side-by-side-cell sn-diff-${leftType}`, text: line.left?.text ?? "" });
        grid.createDiv({ cls: `sn-side-by-side-cell sn-diff-${rightType}`, text: line.right?.text ?? "" });
      }
    }
  }

  private getOrCreateLineChoices(sysId: string, sectionKey: string): Map<number, boolean> {
    if (!this.lineChoices.has(sysId)) this.lineChoices.set(sysId, new Map());
    const sysMap = this.lineChoices.get(sysId)!;
    if (!sysMap.has(sectionKey)) sysMap.set(sectionKey, new Map());
    return sysMap.get(sectionKey)!;
  }

  private renderInteractiveDiff(
    container: HTMLElement,
    sysId: string,
    sectionKey: string,
    localBody: string,
    remoteBody: string,
  ): DiffLine[] {
    const allLines = computeSideBySide(localBody, remoteBody);
    const diffLines = computeDiff(localBody, remoteBody);

    if (allLines.length === 0) {
      container.createEl("p", { text: "Contents are identical.", cls: "sn-conflict-empty" });
      return diffLines;
    }

    // Initialize per-line defaults using change group analysis
    const choices = this.getOrCreateLineChoices(sysId, sectionKey);
    const changeGroups = extractChangeGroups(diffLines);
    for (const cg of changeGroups) {
      for (let idx = cg.startLine; idx <= cg.endLine; idx++) {
        if (choices.has(idx)) continue;
        const line = diffLines[idx]!;
        if (cg.hasLocal && cg.hasRemote) {
          // Overlapping: removed → true, added → false
          choices.set(idx, line.type === "removed");
        } else {
          // Non-overlapping: include all
          choices.set(idx, true);
        }
      }
    }

    // Identify non-context rows for rendering
    const nonContextRows = new Set<number>();
    for (let r = 0; r < allLines.length; r++) {
      const line = allLines[r]!;
      if (!(line.left?.type === "context" && line.right?.type === "context")) {
        nonContextRows.add(r);
      }
    }

    // Compute visible ranges (non-context rows + 3 lines context)
    const CTX = 3;
    const ranges: { start: number; end: number }[] = [];
    const sortedNonCtx = [...nonContextRows].sort((a, b) => a - b);
    for (const r of sortedNonCtx) {
      const s = Math.max(0, r - CTX);
      const e = Math.min(allLines.length - 1, r + CTX);
      if (ranges.length > 0 && s <= ranges[ranges.length - 1]!.end + 1) {
        ranges[ranges.length - 1]!.end = e;
      } else {
        ranges.push({ start: s, end: e });
      }
    }

    // Legend
    const legend = container.createDiv({ cls: "sn-diff-legend" });
    legend.createEl("span", { text: "Included in merge", cls: "sn-diff-legend-item sn-diff-legend-included" });
    legend.createEl("span", { text: "Excluded", cls: "sn-diff-legend-item sn-diff-legend-excluded" });
    legend.createEl("span", { text: "Click a line to toggle", cls: "sn-diff-legend-hint" });

    const grid = container.createDiv({ cls: "sn-side-by-side" });
    grid.createDiv({ cls: "sn-side-by-side-header", text: "Local (Obsidian)" });
    grid.createDiv({ cls: "sn-side-by-side-header", text: "Remote (ServiceNow)" });

    for (let rIdx = 0; rIdx < ranges.length; rIdx++) {
      if (rIdx > 0) {
        grid.createDiv({ cls: "sn-side-by-side-cell sn-diff-separator", text: "\u22EF" });
        grid.createDiv({ cls: "sn-side-by-side-cell sn-diff-separator", text: "\u22EF" });
      }

      const range = ranges[rIdx]!;
      for (let row = range.start; row <= range.end; row++) {
        const line = allLines[row]!;

        if (!nonContextRows.has(row)) {
          // Context row
          grid.createDiv({ cls: "sn-side-by-side-cell sn-diff-context", text: line.left?.text ?? "" });
          grid.createDiv({ cls: "sn-side-by-side-cell sn-diff-context", text: line.right?.text ?? "" });
          continue;
        }

        // Left cell
        const leftIdx = line.left?.diffIndex;
        const leftHasChange = line.left != null && line.left.type !== "context";
        let leftCls: string;
        if (!line.left) leftCls = "sn-diff-empty";
        else if (!leftHasChange) leftCls = "sn-diff-context";
        else leftCls = (leftIdx !== undefined && choices.get(leftIdx)) ? "sn-diff-included" : "sn-diff-excluded";

        const leftCell = grid.createDiv({
          cls: `sn-side-by-side-cell ${leftCls}${leftHasChange ? " sn-hunk-clickable" : ""}`,
          text: line.left?.text ?? "",
        });
        if (leftHasChange && leftIdx !== undefined) {
          leftCell.addEventListener("click", () => {
            choices.set(leftIdx, !choices.get(leftIdx));
            void this.render();
          });
        }

        // Right cell
        const rightIdx = line.right?.diffIndex;
        const rightHasChange = line.right != null && line.right.type !== "context";
        let rightCls: string;
        if (!line.right) rightCls = "sn-diff-empty";
        else if (!rightHasChange) rightCls = "sn-diff-context";
        else rightCls = (rightIdx !== undefined && choices.get(rightIdx)) ? "sn-diff-included" : "sn-diff-excluded";

        const rightCell = grid.createDiv({
          cls: `sn-side-by-side-cell ${rightCls}${rightHasChange ? " sn-hunk-clickable" : ""}`,
          text: line.right?.text ?? "",
        });
        if (rightHasChange && rightIdx !== undefined) {
          rightCell.addEventListener("click", () => {
            choices.set(rightIdx, !choices.get(rightIdx));
            void this.render();
          });
        }
      }
    }

    return diffLines;
  }

  private renderTriageList(container: HTMLElement, conflicts: ConflictEntry[]) {
    const conflictActions = container.createDiv({ cls: "sn-conflict-actions" });
    const clearStaleBtn = conflictActions.createEl("button", { text: "Clear stale conflicts", cls: "sn-action-btn" });
    clearStaleBtn.addEventListener("click", () => {
      void (async () => {
        const cleared = await this.plugin.conflictResolver.clearStaleConflicts();
        new Notice(cleared > 0
          ? `Cleared ${cleared} stale conflict${cleared > 1 ? "s" : ""}`
          : "No stale conflicts found");
        await this.render();
      })();
    });
    const dismissAllBtn = conflictActions.createEl("button", { text: "Dismiss all", cls: "sn-action-btn sn-action-btn-danger" });
    dismissAllBtn.addEventListener("click", () => {
      void (async () => {
        await this.plugin.conflictResolver.clearAllConflicts();
        this.perSectionChoices.clear();
        this.hunkChoices.clear();
        this.lineChoices.clear();
        new Notice("All conflicts dismissed");
        await this.render();
      })();
    });

    const conflictList = container.createDiv({ cls: "sn-conflict-list" });
    for (const conflict of conflicts) {
      this.renderTriageRow(conflictList, conflict);
    }
  }

  private renderTriageRow(container: HTMLElement, conflict: ConflictEntry) {
    const fileName = conflict.path.split("/").pop() ?? conflict.path;
    const sc = conflict.sectionConflicts;
    const hasSections = sc && sc.length > 0;

    const row = container.createDiv({ cls: "sn-conflict-row" });

    const info = row.createDiv({ cls: "sn-conflict-info" });
    info.createEl("span", { text: fileName, cls: "sn-conflict-name" });

    const meta = info.createDiv({ cls: "sn-conflict-meta" });
    if (conflict.remoteTimestamp) {
      const remoteMtime = new Date(conflict.remoteTimestamp.replace(" ", "T"));
      const remoteTimeStr = isNaN(remoteMtime.getTime())
        ? conflict.remoteTimestamp
        : remoteMtime.toLocaleDateString();
      meta.createEl("span", { text: `Remote: ${remoteTimeStr}` });
    }

    if (hasSections) {
      const names = sc.map((s) => s.heading.replace(/^###\s*/, "") || "Document body");
      const sectionNames = info.createDiv({ cls: "sn-conflict-section-names" });
      sectionNames.createEl("strong", { text: "Conflicts in: " });
      sectionNames.appendText(names.join(", "));
    } else {
      const sectionNames = info.createDiv({ cls: "sn-conflict-section-names" });
      sectionNames.createEl("strong", { text: "Whole-file conflict" });
    }

    // Action buttons
    const actions = row.createDiv({ cls: "sn-conflict-row-actions" });

    const openBtn = actions.createEl("button", { text: "Open", cls: "sn-action-btn" });
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const file = this.plugin.app.vault.getAbstractFileByPath(conflict.path);
      if (file instanceof TFile) {
        void this.plugin.app.workspace.getLeaf(false).openFile(file);
      }
    });

    if (hasSections) {
      const diffBtn = actions.createEl("button", { text: "View diff", cls: "sn-action-btn mod-cta" });
      diffBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.viewMode = "drill-in";
        this.drillInSysId = conflict.sysId;
        void this.render();
      });
    }

    // Whole-file fallback buttons (no sections)
    if (!hasSections) {
      const pullBtn = actions.createEl("button", { text: "Pull remote", cls: "sn-action-btn mod-cta" });
      pullBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void (async () => {
          await this.plugin.conflictResolver.resolveWithPull(conflict.sysId);
          await this.render();
        })();
      });
      const pushBtn = actions.createEl("button", { text: "Push local", cls: "sn-action-btn" });
      pushBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void (async () => {
          await this.plugin.conflictResolver.resolveWithPush(conflict.sysId);
          await this.render();
        })();
      });
    }

    const dismissBtn = actions.createEl("button", { text: "Dismiss", cls: "sn-action-btn sn-action-btn-danger" });
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        delete this.plugin.syncState.conflicts[conflict.sysId];
        this.perSectionChoices.delete(conflict.sysId);
        await this.plugin.saveSettings();
        await this.render();
      })();
    });

    // Per-section quick buttons (only if sections exist)
    if (hasSections) {
      const quickActions = container.createDiv({ cls: "sn-conflict-quick-actions" });
      quickActions.addEventListener("click", (e) => e.stopPropagation());

      if (!this.perSectionChoices.has(conflict.sysId)) {
        this.perSectionChoices.set(conflict.sysId, new Map());
      }
      const choices = this.perSectionChoices.get(conflict.sysId)!;

      for (const s of sc) {
        const sectionRow = quickActions.createDiv({ cls: "sn-conflict-quick-section" });
        const quickName = s.heading.replace(/^###\s*/, "") || "Document body";
        sectionRow.createEl("span", { text: quickName, cls: "sn-conflict-quick-section-name" });

        const btns = sectionRow.createDiv({ cls: "sn-conflict-quick-btns" });
        const currentChoice = choices.get(s.key);

        const remoteBtn = btns.createEl("button", {
          text: "Remote",
          cls: `sn-conflict-quick-btn ${currentChoice === "remote" ? "is-chosen" : ""}`,
        });
        remoteBtn.addEventListener("click", () => {
          choices.set(s.key, "remote");
          void this.render();
        });

        const localBtn = btns.createEl("button", {
          text: "Local",
          cls: `sn-conflict-quick-btn ${currentChoice === "local" ? "is-chosen" : ""}`,
        });
        localBtn.addEventListener("click", () => {
          choices.set(s.key, "local");
          void this.render();
        });
      }

      // Apply button — only shows when all sections have a choice
      if (choices.size === sc.length) {
        const applyBtn = quickActions.createEl("button", {
          text: "Apply choices",
          cls: "sn-action-btn mod-cta",
        });
        applyBtn.addEventListener("click", () => {
          void (async () => {
            await this.plugin.conflictResolver.resolvePerSection(conflict.sysId, choices);
            this.perSectionChoices.delete(conflict.sysId);
            await this.render();
          })();
        });
      }
    }
  }

  private renderTree(container: HTMLElement) {
    const treePane = container.createDiv({ cls: "sn-tree-pane" });
    const docs = this.getFilteredDocs();

    const tree = new Map<string, Map<string, SNDocument[]>>();
    for (const doc of docs) {
      const proj = doc.project || "";
      if (!tree.has(proj)) tree.set(proj, new Map());
      const projMap = tree.get(proj)!;
      const cat = doc.category || "";
      if (!projMap.has(cat)) projMap.set(cat, []);
      projMap.get(cat)!.push(doc);
    }

    const allNode = treePane.createDiv({ cls: `sn-tree-node ${!this.selectedTreeNode ? "is-active" : ""}` });
    allNode.createEl("span", { text: `All (${docs.length})` });
    allNode.addEventListener("click", () => {
      this.selectedTreeNode = "";
      void this.render();
    });

    for (const [project, categories] of tree) {
      const projKey = `project:${project}`;
      const projCount = Array.from(categories.values()).reduce((sum, d) => sum + d.length, 0);
      const isExpanded = this.expandedNodes.has(projKey);

      const projNode = treePane.createDiv({ cls: "sn-tree-node sn-tree-project" });
      const projHeader = projNode.createDiv({ cls: "sn-tree-header" });
      projHeader.createEl("span", {
        text: isExpanded ? "▼" : "▶",
        cls: "sn-tree-arrow",
      });
      const projDisplay = this.resolveTreeLabel("projects", project) || "(No Project)";
      projHeader.createEl("span", {
        text: `${projDisplay} (${projCount})`,
        cls: `sn-tree-label ${this.selectedTreeNode === projKey ? "is-active" : ""}`,
      });

      projHeader.addEventListener("click", () => {
        if (isExpanded) {
          this.expandedNodes.delete(projKey);
        } else {
          this.expandedNodes.add(projKey);
        }
        this.selectedTreeNode = projKey;
        void this.render();
      });

      projHeader.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => {
          const projMenuLabel = this.resolveTreeLabel("projects", project) || project;
          item.setTitle(`Exclude "${projMenuLabel}" from sync`);
          item.onClick(async () => {
            const pattern = `${project}/`;
            if (!this.plugin.settings.excludePaths.includes(pattern)) {
              this.plugin.settings.excludePaths.push(pattern);
              await this.plugin.saveSettings();
              new Notice(`Excluded "${project}" from sync`);
            }
          });
        });
        menu.showAtMouseEvent(e);
      });

      if (isExpanded) {
        const catContainer = projNode.createDiv({ cls: "sn-tree-children" });
        for (const [category, catDocs] of categories) {
          const catKey = `${projKey}/category:${category}`;
          const catNode = catContainer.createDiv({
            cls: `sn-tree-node sn-tree-category ${this.selectedTreeNode === catKey ? "is-active" : ""}`,
          });
          const catDisplay = this.resolveTreeLabel("categories", category) || "(Uncategorized)";
          catNode.createEl("span", { text: `${catDisplay} (${catDocs.length})` });
          catNode.addEventListener("click", (e) => {
            e.stopPropagation();
            this.selectedTreeNode = catKey;
            void this.render();
          });
        }
      }
    }
  }

  private getDocsForSelectedNode(): SNDocument[] {
    const docs = this.getFilteredDocs();
    if (!this.selectedTreeNode) return docs;

    const parts = this.selectedTreeNode.split("/");
    const projectMatch = parts[0]?.replace("project:", "") ?? "";
    const categoryMatch = parts[1]?.replace("category:", "") ?? "";

    return docs.filter((doc) => {
      const proj = doc.project || "";
      if (proj !== projectMatch) return false;
      if (categoryMatch) {
        const cat = doc.category || "";
        if (cat !== categoryMatch) return false;
      }
      return true;
    });
  }

  private resolveTreeLabel(type: "projects" | "categories", value: string): string {
    if (!this.metadata || !value) return value;
    const entry = this.metadata[type].find((e) => e.value === value);
    return entry?.label ?? value;
  }

  private renderDocList(container: HTMLElement) {
    const listPane = container.createDiv({ cls: "sn-list-pane" });
    const docs = this.getDocsForSelectedNode();

    const actionBar = listPane.createDiv({ cls: "sn-action-bar" });
    const selectedCount = this.selectedDocIds.size;
    actionBar.createEl("span", {
      text: `${docs.length} documents${selectedCount > 0 ? ` · ${selectedCount} selected` : ""}`,
      cls: "sn-action-count",
    });

    if (selectedCount > 0) {
      const downloadBtn = actionBar.createEl("button", {
        text: `Download selected (${selectedCount})`,
        cls: "sn-action-btn mod-cta",
      });
      downloadBtn.addEventListener("click", () => void this.downloadSelected());
    }

    const downloadAllBtn = actionBar.createEl("button", {
      text: "Download all not synced",
      cls: "sn-action-btn",
    });
    downloadAllBtn.addEventListener("click", () => void this.downloadAllUnsynced(docs));

    const list = listPane.createDiv({ cls: "sn-doc-list" });
    for (const doc of docs) {
      const status = this.getDocStatus(doc);
      const isSelected = this.selectedDocIds.has(doc.sys_id);

      const row = list.createDiv({ cls: `sn-doc-row ${isSelected ? "is-selected" : ""}` });

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = isSelected;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selectedDocIds.add(doc.sys_id);
        } else {
          this.selectedDocIds.delete(doc.sys_id);
        }
        void this.render();
      });

      const statusIcon = status === "synced" ? "●" : "○";
      const statusCls = status === "synced" ? "sn-doc-status-synced" : "sn-doc-status-unsynced";
      row.createEl("span", { text: statusIcon, cls: `sn-doc-status ${statusCls}` });

      row.createEl("span", { text: doc.title, cls: "sn-doc-title" });

      if (doc.category) {
        const label = this.metadata?.categories.find((c) => c.value === doc.category)?.label ?? doc.category;
        row.createEl("span", { text: label, cls: "sn-doc-badge" });
      }

      if (doc.sys_updated_on) {
        const date = doc.sys_updated_on.split(" ")[0] ?? "";
        row.createEl("span", { text: date, cls: "sn-doc-meta" });
      }


      row.addEventListener("dblclick", () => {
        const entry = this.plugin.syncState.docMap[doc.sys_id];
        if (entry) {
          const file = this.plugin.app.vault.getAbstractFileByPath(entry.path);
          if (file instanceof TFile) {
            void this.plugin.app.workspace.getLeaf(false).openFile(file);
          }
        }
      });
    }
  }

  private async downloadSelected() {
    const docs = this.serverDocs.filter((d) => this.selectedDocIds.has(d.sys_id));
    await this.downloadDocs(docs);
    this.selectedDocIds.clear();
    await this.render();
  }

  private async downloadAllUnsynced(docs: SNDocument[]) {
    const unsynced = docs.filter((d) => this.getDocStatus(d) === "not-downloaded");
    await this.downloadDocs(unsynced);
    await this.render();
  }

  private async downloadDocs(docs: SNDocument[]) {
    if (docs.length === 0) {
      new Notice("No documents to download.");
      return;
    }

    new Notice(`Downloading ${docs.length} documents...`);
    let count = 0;

    for (const doc of docs) {
      try {
        await this.plugin.syncEngine.createLocalFile(doc);
        count++;
        if (count % 10 === 0) {
          new Notice(`Downloaded ${count}/${docs.length}...`);
        }
      } catch (e) {
        console.error(`Snobby Browser: Failed to download ${doc.title}`, e);
      }
    }

    await this.plugin.saveSettings();
    new Notice(`Downloaded ${count} documents.`);
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  constructor(app: import("obsidian").App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      )
      .addButton((btn) =>
        btn
          .setButtonText("Continue")
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
