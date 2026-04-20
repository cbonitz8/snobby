import { Notice, Plugin } from "obsidian";
import { SNBrowserView, VIEW_TYPE_SN_BROWSER } from "./sn-browser-view";
import { DEFAULT_SETTINGS, DEFAULT_FOLDER_MAPPING, SNSyncSettingTab } from "./settings";
import { AuthManager } from "./auth-manager";
import { ApiClient } from "./api-client";
import { FrontmatterManager } from "./frontmatter-manager";
import { FileWatcher } from "./file-watcher";
import { ConflictResolver } from "./conflict-resolver";
import { SyncEngine } from "./sync-engine";
import { BaseCache } from "./base-cache";
import type { SNSyncSettings, SyncState, AuthTokens, PluginData } from "./types";

const DEFAULT_SYNC_STATE: SyncState = {
  lastSyncTimestamp: "",
  ignoredIds: [],
  docMap: {},
  conflicts: {},
};

const DEFAULT_AUTH: AuthTokens = {
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
};

type StatusBarState = "idle" | "syncing" | "error" | "offline" | "auth-expired";

export default class SNSyncPlugin extends Plugin {
  settings!: SNSyncSettings;
  syncState!: SyncState;
  authTokens!: AuthTokens;
  authManager!: AuthManager;
  apiClient!: ApiClient;
  frontmatterManager!: FrontmatterManager;
  fileWatcher!: FileWatcher;
  conflictResolver!: ConflictResolver;
  syncEngine!: SyncEngine;
  private statusBarEl: HTMLElement | null = null;
  private pendingCount = 0;
  private activeConflictNotice: Notice | null = null;

  async onload() {
    await this.loadSettings();

    if (!this.settings.instanceUrl || !this.settings.apiPath) {
      new Notice("Snobby: configure your ServiceNow connection in settings.");
    }

    this.authManager = new AuthManager(this);
    this.apiClient = new ApiClient(
      this.authManager,
      this.settings.instanceUrl,
      this.settings.apiPath,
      this.settings.metadataPath
    );
    this.frontmatterManager = new FrontmatterManager(
      this.app,
      this.settings.frontmatterPrefix
    );
    this.fileWatcher = new FileWatcher(this, this.frontmatterManager, this.apiClient);
    const baseCache = new BaseCache(this.app, this.manifest.dir!);
    this.conflictResolver = new ConflictResolver(this, baseCache);
    this.syncEngine = new SyncEngine(
      this,
      this.apiClient,
      this.frontmatterManager,
      this.fileWatcher,
      this.conflictResolver,
      baseCache
    );

    const redirectUri = this.settings.oauthRedirectUri;
    const handlerMatch = redirectUri.match(/^obsidian:\/\/(.+)/);
    if (handlerMatch) {
      this.registerObsidianProtocolHandler(handlerMatch[1]!, async (params) => {
        if (params.code) {
          // Validate OAuth code: alphanumeric + common token chars, max 512
          if (params.code.length > 512 || !/^[\w\-./+=]+$/.test(params.code)) {
            new Notice("Authentication failed: invalid authorization code.");
            return;
          }
          await this.authManager.handleCallback(params.code, params.state);
        }
      });
    }

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("idle");

    this.statusBarEl.addEventListener("click", () => {
      void this.syncEngine.sync();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncEngine.sync(),
    });

    this.addCommand({
      id: "initial-pull",
      name: "Initial pull (download all documents)",
      callback: () => void this.syncEngine.initialPull(),
    });

    this.addCommand({
      id: "bulk-push",
      name: "Bulk push (upload all unsynced documents to SN)",
      callback: () => void this.syncEngine.bulkPush(),
    });

    this.addCommand({
      id: "bulk-update",
      name: "Bulk update (re-push all synced documents to SN)",
      callback: () => void this.syncEngine.bulkUpdate(),
    });

    this.addCommand({
      id: "resolve-pull-remote",
      name: "Resolve conflict: pull remote",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const conflict = this.conflictResolver.getConflictForPath(file.path);
        if (!conflict) return false;
        if (checking) return true;
        void this.conflictResolver.resolveWithPull(conflict.sysId);
        return true;
      },
    });

    this.addCommand({
      id: "resolve-push-local",
      name: "Resolve conflict: push local",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const conflict = this.conflictResolver.getConflictForPath(file.path);
        if (!conflict) return false;
        if (checking) return true;
        void this.conflictResolver.resolveWithPush(conflict.sysId);
        return true;
      },
    });

    this.addCommand({
      id: "clear-stale-conflicts",
      name: "Clear stale conflicts",
      callback: async () => {
        const cleared = await this.conflictResolver.clearStaleConflicts();
        new Notice(cleared > 0
          ? `Snobby: cleared ${cleared} stale conflict${cleared > 1 ? "s" : ""}`
          : "Snobby: no stale conflicts found");
      },
    });

    this.addCommand({
      id: "dismiss-all-conflicts",
      name: "Dismiss all conflicts",
      callback: async () => {
        const cleared = await this.conflictResolver.clearAllConflicts();
        new Notice(cleared > 0
          ? `Snobby: dismissed ${cleared} conflict${cleared > 1 ? "s" : ""}`
          : "Snobby: no conflicts to dismiss");
      },
    });

    this.addSettingTab(new SNSyncSettingTab(this.app, this));

    this.registerView(
      VIEW_TYPE_SN_BROWSER,
      (leaf) => new SNBrowserView(leaf, this)
    );

    this.addCommand({
      id: "open-sn-browser",
      name: "Open browser",
      callback: () => {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SN_BROWSER);
        if (existing.length > 0) {
          void this.app.workspace.revealLeaf(existing[0]!);
        } else {
          const leaf = this.app.workspace.getLeaf("tab");
          void leaf.setViewState({ type: VIEW_TYPE_SN_BROWSER, active: true });
        }
      },
    });

    this.fileWatcher.start();
    this.syncEngine.start();
    void this.conflictResolver.migrateMarkerFiles();
    void this.checkDuplicateSysIds();
    void baseCache.evictOrphans(new Set(Object.keys(this.syncState.docMap)));

    void this.conflictResolver.clearStaleConflicts().then((cleared) => {
      if (cleared > 0) {
        new Notice(`Snobby: cleared ${cleared} stale conflict${cleared > 1 ? "s" : ""}`);
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.checkActiveConflictState();
      })
    );
  }

  onunload() {
    this.syncEngine.stop();
  }

  async loadSettings() {
    const data: Partial<PluginData> = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);

    // Migrate legacy username → userSysId
    if (!this.settings.userSysId && data.settings) {
      const legacyUsername = (data.settings as unknown as Record<string, unknown>).username;
      if (typeof legacyUsername === "string" && legacyUsername) {
        if (/^[a-f0-9]{32}$/i.test(legacyUsername)) {
          this.settings.userSysId = legacyUsername;
        }
      }
    }
    delete (this.settings as unknown as Record<string, unknown>).username;

    this.syncState = Object.assign({}, DEFAULT_SYNC_STATE, data.syncState);
    this.syncState.ignoredIds = [...new Set(this.syncState.ignoredIds)];

    // Load auth tokens from local storage (secure, not synced via cloud)
    const storedAuth = this.app.loadLocalStorage("snobby-auth-tokens");
    if (storedAuth) {
      try { this.authTokens = Object.assign({}, DEFAULT_AUTH, JSON.parse(storedAuth)); }
      catch { this.authTokens = Object.assign({}, DEFAULT_AUTH); }
    } else if (data.auth) {
      // Migrate from data.json → local storage
      this.authTokens = Object.assign({}, DEFAULT_AUTH, data.auth);
      this.app.saveLocalStorage("snobby-auth-tokens", JSON.stringify(this.authTokens));
    } else {
      this.authTokens = Object.assign({}, DEFAULT_AUTH);
    }

    // Load client secret from local storage
    const storedSecret = this.app.loadLocalStorage("snobby-client-secret");
    if (storedSecret) {
      this.settings.oauthClientSecret = storedSecret;
    } else if (this.settings.oauthClientSecret) {
      // Migrate from data.json → local storage
      this.app.saveLocalStorage("snobby-client-secret", this.settings.oauthClientSecret);
    }

    const saved = this.settings.folderMapping;
    saved.categories = Object.assign(
      {},
      DEFAULT_FOLDER_MAPPING.categories,
      saved.categories
    );

    // Clear migrated secrets from data.json on next save
    if (data.auth || (data.settings as unknown as Record<string, unknown>)?.oauthClientSecret) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    // Strip secrets before writing to data.json (synced file)
    const settingsToSave = { ...this.settings, oauthClientSecret: "" };
    const data: PluginData = {
      settings: settingsToSave,
      syncState: this.syncState,
    };
    await this.saveData(data);
    // Persist tokens + secret to local storage (local-only, not synced)
    this.app.saveLocalStorage("snobby-auth-tokens", JSON.stringify(this.authTokens));
    if (this.settings.oauthClientSecret) {
      this.app.saveLocalStorage("snobby-client-secret", this.settings.oauthClientSecret);
    }
  }

  async fetchMetadata() {
    return this.apiClient.getMetadata();
  }

  async openConflictInBrowser(sysId: string) {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SN_BROWSER);
    let leaf;
    if (existing.length > 0) {
      leaf = existing[0]!;
      void this.app.workspace.revealLeaf(leaf);
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_SN_BROWSER, active: true });
    }
    const view = leaf.view;
    if (view instanceof SNBrowserView) {
      await view.showConflict(sysId);
    }
  }

  refreshBrowserView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SN_BROWSER);
    for (const leaf of leaves) {
      if (leaf.view instanceof SNBrowserView) {
        void leaf.view.render();
      }
    }
  }

  private async checkDuplicateSysIds() {
    const prefix = this.settings.frontmatterPrefix;
    const sysIdMap = new Map<string, string[]>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const sysId = cache?.frontmatter?.[`${prefix}sys_id`];
      if (!sysId) continue;
      const paths = sysIdMap.get(sysId);
      if (paths) {
        paths.push(file.path);
      } else {
        sysIdMap.set(sysId, [file.path]);
      }
    }

    const duplicates = Array.from(sysIdMap.entries()).filter(([, paths]) => paths.length > 1);
    if (duplicates.length > 0) {
      for (const [sysId, paths] of duplicates) {
        console.warn(`Snobby: duplicate sn_sys_id ${sysId.slice(0, 8)} on: ${paths.join(", ")}`);
      }
      const count = duplicates.reduce((sum, [, p]) => sum + p.length, 0);
      new Notice(`Snobby: ${count} files share duplicate sys_ids. Check console for details. Files created from templates may need sn_sys_id cleared.`, 10000);
    }
  }

  restartSyncEngine() {
    this.apiClient.updateConfig(this.settings.instanceUrl, this.settings.apiPath, this.settings.metadataPath);
    this.frontmatterManager.updatePrefix(this.settings.frontmatterPrefix);
    this.syncEngine.restart();
  }

  updateStatusBar(state: StatusBarState) {
    if (!this.statusBarEl) return;

    switch (state) {
      case "idle": {
        const pendingCount = Object.keys(this.syncState.docMap).length > 0
          ? this.pendingCount
          : 0;
        this.statusBarEl.setText(
          pendingCount > 0 ? `SN: ${pendingCount} pending` : "Snobby: synced"
        );
        break;
      }
      case "syncing":
        this.statusBarEl.setText(`Snobby: syncing...`);
        break;
      case "error":
        this.statusBarEl.setText("Snobby: error");
        break;
      case "offline":
        this.statusBarEl.setText("Snobby: offline");
        break;
      case "auth-expired":
        this.statusBarEl.setText("Snobby: auth expired");
        break;
    }
  }

  setPendingCount(count: number) {
    this.pendingCount = count;
  }

  private checkActiveConflictState() {
    if (this.activeConflictNotice) {
      this.activeConflictNotice.hide();
      this.activeConflictNotice = null;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    const conflict = this.conflictResolver.getConflictForPath(file.path);
    if (!conflict) return;

    const frag = document.createDocumentFragment();
    const container = frag.createEl("div", { cls: "sn-conflict-notice" });
    container.createEl("div", { text: "Sync conflict", cls: "sn-conflict-notice-title" });
    container.createEl("div", {
      text: `"${file.basename}" has conflicting remote changes.`,
      cls: "sn-conflict-notice-body",
    });
    const viewBtn = container.createEl("button", {
      text: "View details",
      cls: "sn-action-btn sn-conflict-notice-btn",
    });
    viewBtn.addEventListener("click", () => {
      void this.openConflictInBrowser(conflict.sysId);
      if (this.activeConflictNotice) {
        this.activeConflictNotice.hide();
        this.activeConflictNotice = null;
      }
    });

    this.activeConflictNotice = new Notice(frag, 0);
  }

  updateSyncProgress(pulled: number, pushed: number) {
    if (!this.statusBarEl) return;
    const parts: string[] = [];
    if (pulled > 0) parts.push(`${pulled} pulled`);
    if (pushed > 0) parts.push(`${pushed} pushed`);
    this.statusBarEl.setText(
      parts.length > 0
        ? `Snobby: syncing... (${parts.join(", ")})`
        : "Snobby: syncing..."
    );
  }
}
