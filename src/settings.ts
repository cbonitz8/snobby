import { App, PluginSettingTab, Setting } from "obsidian";
import type SNSyncPlugin from "./main";
import type { SNSyncSettings, FolderMapping } from "./types";

export const DEFAULT_FOLDER_MAPPING: FolderMapping = {
  projects: true,
  categories: {},
  custom: [],
};

export const DEFAULT_SETTINGS: SNSyncSettings = {
  instanceUrl: "",
  apiPath: "",
  metadataPath: "/metadata",
  oauthRedirectUri: "obsidian://sn-obsidian-sync/callback",
  oauthClientId: "",
  oauthClientSecret: "",
  syncMode: "interval",
  syncIntervalSeconds: 30,
  frontmatterPrefix: "sn_",
  checkoutOnEdit: true,
  localDeleteBehavior: "ignore",
  remoteDeleteBehavior: "delete local",
  folderMapping: DEFAULT_FOLDER_MAPPING,
  excludePaths: [],
};

export class SNSyncSettingTab extends PluginSettingTab {
  plugin: SNSyncPlugin;

  constructor(app: App, plugin: SNSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const details = containerEl.createEl("details", { cls: "sn-setup-info" });
    const summary = details.createEl("summary");
    summary.createEl("span", { text: "Setup Information" });

    new Setting(details)
      .setName("Documentation")
      .setDesc("Setup guide, API contract, and configuration reference")
      .addButton((button) =>
        button.setButtonText("Open README").onClick(() => {
          window.open("https://github.com/cbonitz8/sn-obsidian-sync#readme");
        })
      );

    const routesEl = details.createDiv({ cls: "sn-routes-reference" });
    routesEl.createEl("h4", { text: "Expected API Routes" });
    routesEl.createEl("p", {
      text: "Your Scripted REST API must implement these endpoints relative to the API path configured below:",
      cls: "setting-item-description",
    });
    const routeTable = routesEl.createEl("table", { cls: "sn-routes-table" });
    const routes = [
      ["GET", "/documents", "List all documents"],
      ["GET", "/documents/{id}", "Get single document"],
      ["POST", "/documents", "Create document"],
      ["PUT", "/documents/{id}", "Update document"],
      ["DELETE", "/documents/{id}", "Delete document"],
      ["GET", "/documents/changes?since={ts}", "Get changes since timestamp"],
      ["POST", "/documents/{id}/checkout", "Lock document"],
      ["POST", "/documents/{id}/checkin", "Unlock document"],
      ["POST", "/documents/{id}/force-checkin", "Force unlock"],
      ["GET", "{metadataPath}", "Get categories, projects, tags"],
    ];
    const thead = routeTable.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Method" });
    headerRow.createEl("th", { text: "Path" });
    headerRow.createEl("th", { text: "Purpose" });
    const tbody = routeTable.createEl("tbody");
    for (const [method, path, purpose] of routes) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: method });
      row.createEl("td", { text: path, cls: "sn-route-path" });
      row.createEl("td", { text: purpose });
    }

    containerEl.createEl("h2", { text: "Connection" });

    new Setting(containerEl)
      .setName("Instance URL")
      .setDesc("ServiceNow instance URL")
      .addText((text) =>
        text
          .setPlaceholder("https://instance.service-now.com")
          .setValue(this.plugin.settings.instanceUrl)
          .onChange(async (value) => {
            this.plugin.settings.instanceUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API path")
      .setDesc("Base REST API path for the document endpoint")
      .addText((text) =>
        text
          .setPlaceholder("/api/x_your_scope/your_api")
          .setValue(this.plugin.settings.apiPath)
          .onChange(async (value) => {
            this.plugin.settings.apiPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Metadata path")
      .setDesc("Relative path for the metadata endpoint (categories, projects, tags)")
      .addText((text) =>
        text
          .setPlaceholder("/metadata")
          .setValue(this.plugin.settings.metadataPath)
          .onChange(async (value) => {
            this.plugin.settings.metadataPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OAuth Redirect URI")
      .setDesc("Must match the redirect URL in your SN OAuth Application")
      .addText((text) =>
        text
          .setPlaceholder("obsidian://sn-obsidian-sync/callback")
          .setValue(this.plugin.settings.oauthRedirectUri)
          .onChange(async (value) => {
            this.plugin.settings.oauthRedirectUri = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OAuth Client ID")
      .addText((text) =>
        text
          .setPlaceholder("Client ID")
          .setValue(this.plugin.settings.oauthClientId)
          .onChange(async (value) => {
            this.plugin.settings.oauthClientId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OAuth Client Secret")
      .addText((text) =>
        text
          .setPlaceholder("Client Secret")
          .setValue(this.plugin.settings.oauthClientSecret)
          .onChange(async (value) => {
            this.plugin.settings.oauthClientSecret = value;
            await this.plugin.saveSettings();
          })
      );

    const authStatus = this.plugin.authManager?.isAuthenticated()
      ? "Authenticated"
      : "Not connected";

    new Setting(containerEl)
      .setName("Authentication")
      .setDesc(authStatus)
      .addButton((button) =>
        button.setButtonText("Authenticate").onClick(async () => {
          this.plugin.authManager?.startOAuthFlow();
        })
      );

    containerEl.createEl("h2", { text: "ServiceNow Data" });

    const metadataContainer = containerEl.createDiv();
    metadataContainer.createEl("p", {
      text: "Fetch available options from your ServiceNow instance to verify the connection.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Metadata")
      .setDesc("Fetch categories, projects, and tags from SN")
      .addButton((button) =>
        button.setButtonText("Fetch from SN").onClick(async () => {
          button.setButtonText("Fetching...");
          button.setDisabled(true);
          metadataContainer.empty();

          try {
            const response = await this.plugin.fetchMetadata();
            console.log("Snobby: metadata response", response);

            if (!response || !response.ok || !response.data) {
              metadataContainer.createEl("p", {
                text: `Failed to fetch metadata (HTTP ${response?.status ?? "no response"}). Check your connection settings and authentication.`,
              });
              return;
            }

            const meta = response.data;
            console.log("Snobby: metadata parsed", meta);

            const catSection = metadataContainer.createDiv({ cls: "sn-metadata-section" });
            catSection.createEl("h4", { text: "Categories" });
            if (meta.categories && meta.categories.length > 0) {
              const catList = catSection.createEl("ul");
              for (const cat of meta.categories) {
                catList.createEl("li", { text: `${cat.label} (${cat.value})` });
              }
            } else {
              catSection.createEl("p", { text: "None found" });
            }

            const projSection = metadataContainer.createDiv({ cls: "sn-metadata-section" });
            projSection.createEl("h4", { text: "Projects" });
            if (meta.projects && meta.projects.length > 0) {
              const projList = projSection.createEl("ul");
              for (const proj of meta.projects) {
                projList.createEl("li", { text: `${proj.label} (${proj.value})` });
              }
            } else {
              projSection.createEl("p", { text: "None found" });
            }

            const tagSection = metadataContainer.createDiv({ cls: "sn-metadata-section" });
            tagSection.createEl("h4", { text: "Tags" });
            if (meta.tags && meta.tags.length > 0) {
              tagSection.createEl("p", { text: meta.tags.join(", ") });
            } else {
              tagSection.createEl("p", { text: "No tags yet" });
            }
          } catch (e) {
            console.error("Snobby: metadata fetch error", e);
            metadataContainer.createEl("p", {
              text: `Error: ${e instanceof Error ? e.message : String(e)}`,
            });
          } finally {
            button.setButtonText("Fetch from SN");
            button.setDisabled(false);
          }
        })
      );

    containerEl.createEl("h2", { text: "Sync" });

    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Automatic interval sync or manual trigger only")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("interval", "Interval")
          .addOption("manual", "Manual")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as "interval" | "manual";
            await this.plugin.saveSettings();
            this.plugin.restartSyncEngine();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .setDesc("How often to sync when in interval mode")
      .addSlider((slider) =>
        slider
          .setLimits(10, 300, 5)
          .setValue(this.plugin.settings.syncIntervalSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalSeconds = value;
            await this.plugin.saveSettings();
            this.plugin.restartSyncEngine();
          })
      );

    containerEl.createEl("h2", { text: "Behavior" });

    new Setting(containerEl)
      .setName("Checkout on edit")
      .setDesc("Automatically lock documents in ServiceNow when editing locally")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.checkoutOnEdit)
          .onChange(async (value) => {
            this.plugin.settings.checkoutOnEdit = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Local delete behavior")
      .setDesc("What to do when you delete a synced file from the vault")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ignore", "Ignore (don't re-pull)")
          .addOption("re-pull", "Re-pull from ServiceNow")
          .addOption("archive", "Move to Archive folder")
          .setValue(this.plugin.settings.localDeleteBehavior)
          .onChange(async (value) => {
            this.plugin.settings.localDeleteBehavior = value as "ignore" | "re-pull" | "archive";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote delete behavior")
      .setDesc("What to do when a document is deleted from ServiceNow")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("delete local", "Delete local file")
          .addOption("keep local", "Keep local file (unlink)")
          .setValue(this.plugin.settings.remoteDeleteBehavior)
          .onChange(async (value) => {
            this.plugin.settings.remoteDeleteBehavior = value as "delete local" | "keep local";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Frontmatter prefix")
      .setDesc("Prefix for plugin-managed frontmatter fields (e.g. sn_)")
      .addText((text) =>
        text
          .setPlaceholder("sn_")
          .setValue(this.plugin.settings.frontmatterPrefix)
          .onChange(async (value) => {
            this.plugin.settings.frontmatterPrefix = value;
            await this.plugin.saveSettings();
          })
      );

  }
}
