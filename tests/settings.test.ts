import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings/defaults";

describe("productivity and mobile settings", () => {
  it("keeps sync guarded and companion integrations optional", () => {
    expect(DEFAULT_SETTINGS.toolPolicies.sync).toBe("manual");
    expect(DEFAULT_SETTINGS.integrations.remotelySave).toBe(false);
    expect(DEFAULT_SETTINGS.integrations.tasks).toBe(true);
    expect(DEFAULT_SETTINGS.mobileIndexingEnabled).toBe(true);
  });

  it("merges nested policies and integrations without losing safe defaults", () => {
    const settings = mergeSettings({
      toolPolicies: { ...DEFAULT_SETTINGS.toolPolicies, read: "disabled" },
      integrations: { ...DEFAULT_SETTINGS.integrations, tasks: false },
      embeddingBatchSize: 999,
      interfaceScale: 10
    });
    expect(settings.toolPolicies).toMatchObject({ read: "disabled", sync: "manual" });
    expect(settings.integrations).toMatchObject({ tasks: false, homepage: true });
    expect(settings.embeddingBatchSize).toBe(100);
    expect(settings.interfaceScale).toBe(80);
  });
});
