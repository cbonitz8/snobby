import { Modal, TFile } from "obsidian";
import type SNSyncPlugin from "./main";
import type { ConflictEntry } from "./types";
import { computeDiff, extractHunks } from "./diff";

export class ConflictModal extends Modal {
  private plugin: SNSyncPlugin;
  private conflict: ConflictEntry;
  private resolved = false;

  constructor(plugin: SNSyncPlugin, conflict: ConflictEntry) {
    super(plugin.app);
    this.plugin = plugin;
    this.conflict = conflict;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("sn-conflict-modal");

    const file = this.app.vault.getAbstractFileByPath(this.conflict.path);
    if (!(file instanceof TFile)) {
      contentEl.createEl("p", { text: "File not found — conflict may be stale." });
      return;
    }

    const fileName = file.basename;

    // Header
    contentEl.createEl("h2", { text: fileName });
    contentEl.createEl("p", {
      text: "Both local and remote versions were edited independently",
      cls: "sn-conflict-modal-subtitle",
    });

    // Metadata row
    const metaRow = contentEl.createDiv({ cls: "sn-conflict-modal-meta" });

    const localMtime = new Date(file.stat.mtime);
    const localTimeStr = localMtime.toLocaleString();
    metaRow.createDiv({
      cls: "sn-conflict-modal-meta-local",
      text: `Local \u2014 modified ${localTimeStr}`,
    });

    let remoteText = `Remote \u2014 modified ${this.conflict.remoteTimestamp}`;
    if (this.conflict.lockedBy) {
      remoteText += ` by ${this.conflict.lockedBy}`;
    }
    metaRow.createDiv({
      cls: "sn-conflict-modal-meta-remote",
      text: remoteText,
    });

    // Compute diff
    const rawLocal = await this.app.vault.read(file);
    const localBody = this.stripFrontmatter(rawLocal);
    const remoteBody = this.stripFrontmatter(this.conflict.remoteContent);

    const diffLines = computeDiff(localBody, remoteBody);

    if (diffLines.length === 0) {
      const identical = contentEl.createDiv({ cls: "sn-conflict-modal-identical" });
      identical.createEl("p", { text: "Contents are identical." });
      const clearBtn = identical.createEl("button", {
        text: "Clear conflict",
        cls: "sn-action-btn mod-cta",
      });
      clearBtn.addEventListener("click", () => {
        this.resolved = true;
        delete this.plugin.syncState.conflicts[this.conflict.sysId];
        void this.plugin.saveSettings();
        this.close();
      });
      return;
    }

    // Render hunks
    const hunks = extractHunks(diffLines);
    const diffContainer = contentEl.createDiv({ cls: "sn-conflict-modal-diff" });

    for (let i = 0; i < hunks.length; i++) {
      if (i > 0) {
        diffContainer.createDiv({ cls: "sn-diff-separator", text: "\u22EF" });
      }
      const hunkEl = diffContainer.createDiv({ cls: "sn-diff-hunk" });
      for (const line of hunks[i]!.lines) {
        const lineEl = hunkEl.createDiv({ cls: `sn-diff-line sn-diff-${line.type}` });
        const prefix = line.type === "added" ? "+" : line.type === "removed" ? "\u2212" : " ";
        lineEl.createSpan({ text: prefix, cls: "sn-diff-prefix" });
        lineEl.createSpan({ text: line.text });
      }
    }

    // Action bar
    const actions = contentEl.createDiv({ cls: "sn-conflict-modal-actions" });

    const acceptBtn = actions.createEl("button", {
      text: "Accept remote",
      cls: "sn-action-btn mod-cta",
    });
    acceptBtn.addEventListener("click", () => {
      this.resolved = true;
      void this.plugin.conflictResolver.resolveWithPull(this.conflict.sysId);
      this.close();
    });

    const keepBtn = actions.createEl("button", {
      text: "Keep local",
      cls: "sn-action-btn",
    });
    keepBtn.addEventListener("click", () => {
      this.resolved = true;
      void this.plugin.conflictResolver.resolveWithPush(this.conflict.sysId);
      this.close();
    });

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "sn-action-btn",
    });
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }

  private stripFrontmatter(raw: string): string {
    if (!raw.startsWith("---")) return raw;
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx === -1) return raw;
    return raw.slice(endIdx + 4).replace(/^\n+/, "");
  }
}
