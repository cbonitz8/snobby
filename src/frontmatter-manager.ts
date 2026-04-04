import type { App, TFile } from "obsidian";
import type { SNFrontmatter } from "./types";

export class FrontmatterManager {
  private app: App;
  private prefix: string;

  constructor(app: App, prefix: string) {
    this.app = app;
    this.prefix = prefix;
  }

  updatePrefix(prefix: string) {
    this.prefix = prefix;
  }

  async read(file: TFile): Promise<SNFrontmatter> {
    const result: SNFrontmatter = {};
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) return result;

    result.sys_id = fm[`${this.prefix}sys_id`];
    result.category = fm[`${this.prefix}category`];
    result.project = fm[`${this.prefix}project`];
    result.tags = fm[`${this.prefix}tags`];
    const syncedVal = fm[`${this.prefix}synced`];
    if (syncedVal !== undefined) {
      result.synced = syncedVal === true || syncedVal === "true";
    }

    return result;
  }

  async write(file: TFile, fields: Partial<SNFrontmatter>) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (fields.sys_id !== undefined) fm[`${this.prefix}sys_id`] = fields.sys_id;
      if (fields.category !== undefined) fm[`${this.prefix}category`] = fields.category;
      if (fields.project !== undefined) fm[`${this.prefix}project`] = fields.project;
      if (fields.tags !== undefined) fm[`${this.prefix}tags`] = fields.tags;
      if (fields.synced !== undefined) fm[`${this.prefix}synced`] = fields.synced;
    });
  }

  async clearSysId(file: TFile) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      delete fm[`${this.prefix}sys_id`];
    });
  }

  async markDirty(file: TFile) {
    await this.write(file, { synced: false });
  }

  async markSynced(file: TFile) {
    await this.write(file, { synced: true });
  }
}
