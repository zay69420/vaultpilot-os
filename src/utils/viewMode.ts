export type VaultPilotViewMode = "compact" | "command-center";
export type CommandCenterTab = "today" | "chat" | "search" | "memory";

export function initialTabForViewMode(mode: VaultPilotViewMode): CommandCenterTab {
  return mode === "command-center" ? "today" : "chat";
}
