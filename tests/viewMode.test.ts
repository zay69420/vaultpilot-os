import { describe, expect, it } from "vitest";
import { initialTabForViewMode } from "../src/utils/viewMode";

describe("VaultPilot dual view modes", () => {
  it("opens the right-sidebar view directly in compact chat", () => {
    expect(initialTabForViewMode("compact")).toBe("chat");
  });

  it("opens the full workspace view on the Today dashboard", () => {
    expect(initialTabForViewMode("command-center")).toBe("today");
  });
});
