import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, SNSyncSettingTab } from "./settings";
import { AuthManager } from "./auth-manager";
import { ApiClient } from "./api-client";
import { FrontmatterManager } from "./frontmatter-manager";
import { FileWatcher } from "./file-watcher";
import { ConflictResolver } from "./conflict-resolver";
import { SyncEngine } from "./sync-engine";
import type { SNSyncSettings, SyncState, AuthTokens, PluginData } from "./types";

const DEFAULT_SYNC_STATE: SyncState = {
  lastSyncTimestamp: "",
  ignoredIds: [],
  docMap: {},
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
  private frontmatterManager!: FrontmatterManager;
  private fileWatcher!: FileWatcher;
  private conflictResolver!: ConflictResolver;
  syncEngine!: SyncEngine;
  private statusBarEl: HTMLElement | null = null;
  private pendingCount = 0;

  async onload() {
    await this.loadSettings();

    if (!this.settings.instanceUrl || !this.settings.apiPath) {
      new Notice("SN Sync: Configure your ServiceNow connection in settings.");
    }

    // Initialize modules
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
    this.conflictResolver = new ConflictResolver(this.app, this.frontmatterManager);
    this.syncEngine = new SyncEngine(
      this,
      this.apiClient,
      this.frontmatterManager,
      this.fileWatcher,
      this.conflictResolver
    );

    // Register OAuth callback handler from the configured redirect URI
    // URI format: obsidian://{handler}/callback — extract the handler name
    const redirectUri = this.settings.oauthRedirectUri;
    const handlerMatch = redirectUri.match(/^obsidian:\/\/(.+)/);
    if (handlerMatch) {
      this.registerObsidianProtocolHandler(handlerMatch[1]!, async (params) => {
        if (params.code) {
          await this.authManager.handleCallback(params.code);
        }
      });
    }

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("idle");

    // Click status bar to trigger manual sync
    this.statusBarEl.addEventListener("click", () => {
      this.syncEngine.sync();
    });

    // Commands
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncEngine.sync(),
    });

    this.addCommand({
      id: "initial-pull",
      name: "Initial pull (download all documents)",
      callback: () => this.syncEngine.initialPull(),
    });

    this.addCommand({
      id: "bulk-push",
      name: "Bulk push (upload all unsynced documents to SN)",
      callback: () => this.syncEngine.bulkPush(),
    });

    // Settings tab
    this.addSettingTab(new SNSyncSettingTab(this.app, this));

    // Start file watcher and sync engine
    this.fileWatcher.start();
    this.syncEngine.start();
  }

  async onunload() {
    this.syncEngine.stop();
  }

  async loadSettings() {
    const data: Partial<PluginData> = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    this.syncState = Object.assign({}, DEFAULT_SYNC_STATE, data.syncState);
    this.authTokens = Object.assign({}, DEFAULT_AUTH, data.auth);
  }

  async saveSettings() {
    const data: PluginData = {
      settings: this.settings,
      syncState: this.syncState,
      auth: this.authTokens,
    };
    await this.saveData(data);
  }

  async fetchMetadata() {
    return this.apiClient.getMetadata();
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
          pendingCount > 0 ? `SN: ${pendingCount} pending` : "SN: synced"
        );
        break;
      }
      case "syncing":
        this.statusBarEl.setText("SN: syncing...");
        break;
      case "error":
        this.statusBarEl.setText("SN: error");
        break;
      case "offline":
        this.statusBarEl.setText("SN: offline");
        break;
      case "auth-expired":
        this.statusBarEl.setText("SN: auth expired");
        break;
    }
  }

  /** Update the pending count (called by sync engine) */
  setPendingCount(count: number) {
    this.pendingCount = count;
  }
}
