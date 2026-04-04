import { ItemView, WorkspaceLeaf, Notice, Menu } from "obsidian";
import type SNSyncPlugin from "./main";
import type { SNDocument, SNMetadata } from "./types";

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

  constructor(leaf: WorkspaceLeaf, plugin: SNSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SN_BROWSER;
  }

  getDisplayText(): string {
    return "Snobby Browser";
  }

  getIcon(): string {
    return "cloud";
  }

  async onOpen() {
    await this.render();
  }

  async onClose() {}

  private async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("sn-browser");

    const tabBar = container.createDiv({ cls: "sn-browser-tabs" });
    const browseTab = tabBar.createEl("button", {
      text: "Browse SN",
      cls: `sn-browser-tab ${this.activeTab === "browse" ? "is-active" : ""}`,
    });
    const settingsTab = tabBar.createEl("button", {
      text: "Sync Settings",
      cls: `sn-browser-tab ${this.activeTab === "settings" ? "is-active" : ""}`,
    });

    browseTab.addEventListener("click", () => {
      this.activeTab = "browse";
      this.render();
    });
    settingsTab.addEventListener("click", () => {
      this.activeTab = "settings";
      this.render();
    });

    const content = container.createDiv({ cls: "sn-browser-content" });

    if (this.activeTab === "browse") {
      await this.renderBrowseTab(content);
    } else {
      this.renderSettingsTab(content);
    }
  }

  private async fetchData() {
    if (this.serverDocs.length > 0) return; // use cache
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
      };
      trackedIds.add(sysId);
      added++;
    }

    if (added > 0) {
      await this.plugin.saveSettings();
      console.log(`Snobby Browser: Reconciled ${added} files into docMap`);
    }
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
    projectSelect.createEl("option", { text: "All Projects", value: "" });
    if (this.metadata) {
      for (const proj of this.metadata.projects) {
        const opt = projectSelect.createEl("option", { text: proj.label, value: proj.value });
        if (this.selectedProject === proj.value) opt.selected = true;
      }
    }
    projectSelect.addEventListener("change", () => {
      this.selectedProject = projectSelect.value;
      this.render();
    });

    const categorySelect = filterBar.createEl("select", { cls: "sn-filter-select" });
    categorySelect.createEl("option", { text: "All Categories", value: "" });
    if (this.metadata) {
      for (const cat of this.metadata.categories) {
        const opt = categorySelect.createEl("option", { text: cat.label, value: cat.value });
        if (this.selectedCategory === cat.value) opt.selected = true;
      }
    }
    categorySelect.addEventListener("change", () => {
      this.selectedCategory = categorySelect.value;
      this.render();
    });

    const statusSelect = filterBar.createEl("select", { cls: "sn-filter-select" });
    statusSelect.createEl("option", { text: "All Status", value: "" });
    statusSelect.createEl("option", { text: "Synced", value: "synced" });
    statusSelect.createEl("option", { text: "Not Downloaded", value: "not-downloaded" });
    statusSelect.value = this.selectedStatus;
    statusSelect.addEventListener("change", () => {
      this.selectedStatus = statusSelect.value;
      this.render();
    });

    const searchInput = filterBar.createEl("input", {
      type: "text",
      placeholder: "Search by title...",
      cls: "sn-filter-search",
      value: this.searchQuery,
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.render();
    });

    const refreshBtn = filterBar.createEl("button", { text: "↻", cls: "sn-filter-refresh" });
    refreshBtn.addEventListener("click", () => {
      this.serverDocs = [];
      this.metadata = null;
      this.render();
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

    stats.createEl("h3", { text: "Sync Overview" });
    const statGrid = stats.createDiv({ cls: "sn-stat-grid" });
    statGrid.createDiv({ cls: "sn-stat" }).innerHTML = `<span class="sn-stat-value">${totalServer}</span><span class="sn-stat-label">On Server</span>`;
    statGrid.createDiv({ cls: "sn-stat" }).innerHTML = `<span class="sn-stat-value">${totalLocal}</span><span class="sn-stat-label">Downloaded</span>`;
    statGrid.createDiv({ cls: "sn-stat" }).innerHTML = `<span class="sn-stat-value">${excludeCount}</span><span class="sn-stat-label">Excluded Paths</span>`;

    const excludeSection = container.createDiv({ cls: "sn-exclude-section" });
    excludeSection.createEl("h3", { text: "Excluded from Sync" });
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
    addBtn.addEventListener("click", async () => {
      const value = addInput.value.trim();
      if (!value) return;
      if (!this.plugin.settings.excludePaths.includes(value)) {
        this.plugin.settings.excludePaths.push(value);
        await this.plugin.saveSettings();
      }
      addInput.value = "";
      this.render();
    });

    const list = excludeSection.createDiv({ cls: "sn-exclude-list" });
    if (this.plugin.settings.excludePaths.length === 0) {
      list.createEl("p", { text: "No exclusions configured.", cls: "sn-exclude-empty" });
    } else {
      for (const path of this.plugin.settings.excludePaths) {
        const row = list.createDiv({ cls: "sn-exclude-row" });
        row.createEl("span", { text: path, cls: "sn-exclude-path" });
        const removeBtn = row.createEl("button", { text: "✕", cls: "sn-exclude-remove" });
        removeBtn.addEventListener("click", async () => {
          this.plugin.settings.excludePaths = this.plugin.settings.excludePaths.filter((p) => p !== path);
          await this.plugin.saveSettings();
          this.render();
        });
      }
    }
  }

  private renderTree(container: HTMLElement) {
    const treePane = container.createDiv({ cls: "sn-tree-pane" });
    const docs = this.getFilteredDocs();

    const tree = new Map<string, Map<string, SNDocument[]>>();
    for (const doc of docs) {
      const proj = doc.project || "(No Project)";
      if (!tree.has(proj)) tree.set(proj, new Map());
      const projMap = tree.get(proj)!;
      const cat = doc.category || "(Uncategorized)";
      if (!projMap.has(cat)) projMap.set(cat, []);
      projMap.get(cat)!.push(doc);
    }

    const allNode = treePane.createDiv({ cls: `sn-tree-node ${!this.selectedTreeNode ? "is-active" : ""}` });
    allNode.createEl("span", { text: `All (${docs.length})` });
    allNode.addEventListener("click", () => {
      this.selectedTreeNode = "";
      this.render();
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
      projHeader.createEl("span", {
        text: `${project} (${projCount})`,
        cls: `sn-tree-label ${this.selectedTreeNode === projKey ? "is-active" : ""}`,
      });

      projHeader.addEventListener("click", () => {
        if (isExpanded) {
          this.expandedNodes.delete(projKey);
        } else {
          this.expandedNodes.add(projKey);
        }
        this.selectedTreeNode = projKey;
        this.render();
      });

      projHeader.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle(`Exclude "${project}" from sync`);
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
          catNode.createEl("span", { text: `${category} (${catDocs.length})` });
          catNode.addEventListener("click", (e) => {
            e.stopPropagation();
            this.selectedTreeNode = catKey;
            this.render();
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
      const proj = doc.project || "(No Project)";
      if (proj !== projectMatch) return false;
      if (categoryMatch) {
        const cat = doc.category || "(Uncategorized)";
        if (cat !== categoryMatch) return false;
      }
      return true;
    });
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
        text: `Download Selected (${selectedCount})`,
        cls: "sn-action-btn mod-cta",
      });
      downloadBtn.addEventListener("click", () => this.downloadSelected());
    }

    const downloadAllBtn = actionBar.createEl("button", {
      text: "Download All Not Synced",
      cls: "sn-action-btn",
    });
    downloadAllBtn.addEventListener("click", () => this.downloadAllUnsynced(docs));

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
        this.render();
      });

      const statusIcon = status === "synced" ? "●" : "○";
      const statusColor = status === "synced" ? "var(--color-green)" : "var(--text-faint)";
      row.createEl("span", { text: statusIcon, cls: "sn-doc-status" }).style.color = statusColor;

      row.createEl("span", { text: doc.title, cls: "sn-doc-title" });

      if (doc.category) {
        const label = this.metadata?.categories.find((c) => c.value === doc.category)?.label ?? doc.category;
        row.createEl("span", { text: label, cls: "sn-doc-badge" });
      }

      if (doc.sys_updated_on) {
        const date = doc.sys_updated_on.split(" ")[0] ?? "";
        row.createEl("span", { text: date, cls: "sn-doc-meta" });
      }

      if (doc.checked_out_by) {
        row.createEl("span", { text: "🔒", cls: "sn-doc-lock" });
      }

      row.addEventListener("dblclick", () => {
        const entry = this.plugin.syncState.docMap[doc.sys_id];
        if (entry) {
          const file = this.plugin.app.vault.getAbstractFileByPath(entry.path);
          if (file) {
            this.plugin.app.workspace.getLeaf(false).openFile(file as any);
          }
        }
      });
    }
  }

  private async downloadSelected() {
    const docs = this.serverDocs.filter((d) => this.selectedDocIds.has(d.sys_id));
    await this.downloadDocs(docs);
    this.selectedDocIds.clear();
    this.render();
  }

  private async downloadAllUnsynced(docs: SNDocument[]) {
    const unsynced = docs.filter((d) => this.getDocStatus(d) === "not-downloaded");
    await this.downloadDocs(unsynced);
    this.render();
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
