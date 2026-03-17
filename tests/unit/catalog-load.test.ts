/**
 * Tests Catalog.load() against the real bundled catalog/default.json.
 *
 * Validates that the shipped catalog is structurally sound and that
 * trust profiles apply correctly to real template data.
 */

import { describe, it, expect } from "vitest";
import { Catalog } from "../../src/catalog.js";

describe("Catalog.load() — real default.json", () => {
  it("loads without error", () => {
    expect(() => Catalog.load()).not.toThrow();
  });

  it("has templates and images", () => {
    const catalog = Catalog.load();
    const names = Object.keys(catalog.templates);
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(catalog.images).length).toBeGreaterThan(0);
  });

  it("every template has a valid approval_tier", () => {
    const catalog = Catalog.load();
    const validTiers = ["auto-approve", "human-confirm", "always-deny"];
    for (const [name, t] of Object.entries(catalog.templates)) {
      expect(validTiers, `${name} has invalid tier: ${t.approval_tier}`).toContain(
        t.approval_tier,
      );
    }
  });

  it("actionNames excludes always-deny entries", () => {
    const catalog = Catalog.load();
    const names = catalog.actionNames();
    // Check none of the returned names have always-deny tier
    for (const name of names) {
      expect(catalog.templates[name].approval_tier).not.toBe("always-deny");
    }
  });

  it("actionNames is sorted", () => {
    const catalog = Catalog.load();
    const names = catalog.actionNames();
    expect(names).toEqual([...names].sort());
  });

  it("buildDescription produces non-empty output", () => {
    const catalog = Catalog.load();
    const desc = catalog.buildDescription();
    expect(desc.length).toBeGreaterThan(100);
    expect(desc).toContain("Execute actions in isolated containers");
  });

  it("buildDescription includes a section for each action", () => {
    const catalog = Catalog.load();
    const desc = catalog.buildDescription();
    for (const name of catalog.actionNames()) {
      expect(desc, `missing section for ${name}`).toContain(`## ${name}`);
    }
  });
});

describe("Catalog.load() trust profiles", () => {
  it("conservative profile sets exec to human-confirm", () => {
    const catalog = Catalog.load("conservative");
    expect(catalog.templates.exec.approval_tier).toBe("human-confirm");
  });

  it("power-user profile sets exec to auto-approve", () => {
    const catalog = Catalog.load("power-user");
    expect(catalog.templates.exec.approval_tier).toBe("auto-approve");
  });

  it("standard profile matches default load", () => {
    const standard = Catalog.load("standard");
    const defaultLoad = Catalog.load();
    expect(standard.templates.exec.approval_tier).toBe(
      defaultLoad.templates.exec.approval_tier,
    );
  });
});
