import { BasesView, type BasesPropertyId, type QueryController, setIcon } from "obsidian";
import { isForbiddenVaultPath } from "../security/pathGuard";

export class VaultPilotPriorityBasesView extends BasesView {
  type = "vaultpilot-priority";

  constructor(controller: QueryController, private readonly root: HTMLElement) {
    super(controller);
  }

  onDataUpdated(): void {
    this.root.empty();
    this.root.addClass("vaultpilot-bases-view");
    const entries = this.data.data.filter((entry) => !isForbiddenVaultPath(entry.file.path));
    if (!entries.length) {
      this.root.createEl("p", { cls: "vaultpilot-bases-empty", text: "No notes match this Base." });
      return;
    }

    const list = this.root.createDiv({ cls: "vaultpilot-priority-list", attr: { role: "list" } });
    for (const entry of entries) {
      const card = list.createDiv({ cls: "vaultpilot-priority-card", attr: { role: "listitem" } });
      const open = card.createEl("button", { cls: "vaultpilot-priority-open" });
      const icon = open.createSpan();
      setIcon(icon, "file-text");
      open.createSpan({ text: entry.file.basename });
      open.setAttr("aria-label", `Open ${entry.file.path}`);
      open.addEventListener("click", () => void this.app.workspace.openLinkText(entry.file.path, "", false));

      const properties = card.createDiv({ cls: "vaultpilot-priority-properties" });
      for (const property of this.visibleProperties().slice(0, 6)) {
        const value = entry.getValue(property);
        const text = value?.toString().trim();
        if (!text) continue;
        const row = properties.createDiv({ cls: "vaultpilot-priority-property" });
        row.createSpan({ cls: "vaultpilot-priority-key", text: this.config.getDisplayName(property) });
        row.createSpan({ text });
      }
    }
  }

  private visibleProperties(): BasesPropertyId[] {
    const configured = this.config.getOrder();
    return configured.length ? configured : this.data.properties;
  }
}
