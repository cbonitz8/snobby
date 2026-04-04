import { App, Modal, Setting } from "obsidian";
import type { SNMetadata } from "./types";

export interface NewDocResult {
  category: string;
  project: string;
  tags: string;
}

export class NewDocModal extends Modal {
  private result: NewDocResult;
  private metadata: SNMetadata;
  private onSubmit: (result: NewDocResult) => void;
  private onCancel: () => void;
  private submitted = false;

  constructor(
    app: App,
    metadata: SNMetadata,
    defaults: Partial<NewDocResult>,
    onSubmit: (result: NewDocResult) => void,
    onCancel: () => void
  ) {
    super(app);
    this.metadata = metadata;
    this.result = {
      category: defaults.category ?? "",
      project: defaults.project ?? "",
      tags: defaults.tags ?? "",
    };
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "New ServiceNow Document" });

    new Setting(contentEl)
      .setName("Category")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Select a category...");
        for (const cat of this.metadata.categories) {
          dropdown.addOption(cat.value, cat.label);
        }
        dropdown.setValue(this.result.category);
        dropdown.onChange((value) => {
          this.result.category = value;
        });
      });

    new Setting(contentEl)
      .setName("Project")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Select or type a project...");
        for (const proj of this.metadata.projects) {
          dropdown.addOption(proj.value, proj.label);
        }
        dropdown.setValue(this.result.project);
        dropdown.onChange((value) => {
          this.result.project = value;
        });
      });

    new Setting(contentEl)
      .setName("Tags")
      .setDesc("Comma-separated")
      .addText((text) =>
        text
          .setPlaceholder("tag1, tag2")
          .setValue(this.result.tags)
          .onChange((value) => {
            this.result.tags = value;
          })
      );

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Create")
        .setCta()
        .onClick(() => {
          this.submitted = true;
          this.close();
          this.onSubmit(this.result);
        })
    );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.submitted) {
      this.onCancel();
    }
  }
}

export function promptNewDocMetadata(
  app: App,
  metadata: SNMetadata,
  defaults?: Partial<NewDocResult>
): Promise<NewDocResult | null> {
  return new Promise((resolve) => {
    const modal = new NewDocModal(
      app,
      metadata,
      defaults ?? {},
      (result) => resolve(result),
      () => resolve(null)
    );
    modal.open();
  });
}
