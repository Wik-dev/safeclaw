/**
 * Tests for ADR-002 catalog overlay loading and per-entry tier_overrides.
 *
 * Default catalog provides 16 OpenClaw-native templates; overlays may
 * add or override entries. Per-entry `tier_overrides` win over the
 * blanket TRUST_OVERRIDES table.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../../src/catalog.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "safeclaw-overlay-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeOverlay(payload: object): string {
  const path = join(tmpDir, "overlay.json");
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

describe("Catalog.load() overlay merging", () => {
  it("loads default-only when no overlay path supplied", () => {
    const catalog = Catalog.load();
    expect(Object.keys(catalog.templates).length).toBeGreaterThan(0);
    // Stripped default contains exec, not fleet entries
    expect(catalog.templates.exec).toBeDefined();
    expect(catalog.templates.fleet_status_query).toBeUndefined();
  });

  it("merges overlay templates into defaults", () => {
    const overlayPath = writeOverlay({
      templates: {
        custom_action: {
          description: "A custom deployment-specific action",
          approval_tier: "auto-approve",
          docker_image: "custom-image",
        },
      },
    });
    const catalog = Catalog.load("standard", overlayPath);
    expect(catalog.templates.exec).toBeDefined(); // from default
    expect(catalog.templates.custom_action).toBeDefined(); // from overlay
    expect(catalog.templates.custom_action.approval_tier).toBe("auto-approve");
  });

  it("overlay wins on key collision", () => {
    const overlayPath = writeOverlay({
      templates: {
        exec: {
          description: "Overridden exec",
          approval_tier: "always-deny",
        },
      },
    });
    const catalog = Catalog.load("standard", overlayPath);
    expect(catalog.templates.exec.approval_tier).toBe("always-deny");
    expect(catalog.templates.exec.description).toBe("Overridden exec");
  });

  it("merges overlay images into defaults", () => {
    const overlayPath = writeOverlay({
      templates: {},
      images: { "custom-image": "registry.example.com/custom:latest" },
    });
    const catalog = Catalog.load("standard", overlayPath);
    expect(catalog.images["custom-image"]).toBe(
      "registry.example.com/custom:latest",
    );
    // Defaults preserved
    expect(Object.keys(catalog.images).length).toBeGreaterThan(1);
  });

  it("throws when overlay path is supplied but file is missing", () => {
    expect(() =>
      Catalog.load("standard", join(tmpDir, "does-not-exist.json")),
    ).toThrow();
  });

  it("throws when overlay file is malformed JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ this is not json");
    expect(() => Catalog.load("standard", path)).toThrow();
  });

  it("treats overlay with no templates field as a no-op", () => {
    const overlayPath = writeOverlay({}); // empty object
    expect(() => Catalog.load("standard", overlayPath)).not.toThrow();
    const catalog = Catalog.load("standard", overlayPath);
    expect(catalog.templates.exec).toBeDefined();
  });
});

describe("per-entry tier_overrides (ADR-002 § 3.3)", () => {
  it("entry's tier_overrides wins over blanket TRUST_OVERRIDES", () => {
    const overlayPath = writeOverlay({
      templates: {
        my_tool: {
          description: "Has its own per-profile rules",
          approval_tier: "human-confirm",
          tier_overrides: {
            "power-user": "auto-approve",
          },
        },
      },
    });
    const catalog = Catalog.load("power-user", overlayPath);
    expect(catalog.templates.my_tool.approval_tier).toBe("auto-approve");
  });

  it("falls through to blanket override when profile not in tier_overrides", () => {
    // 'exec' has its own blanket override under power-user (auto-approve);
    // an overlay entry that *also* has tier_overrides for a different profile
    // should not affect that.
    const overlayPath = writeOverlay({
      templates: {
        my_tool: {
          description: "Only declares conservative override",
          approval_tier: "auto-approve",
          tier_overrides: {
            conservative: "human-confirm",
          },
        },
      },
    });
    const power = Catalog.load("power-user", overlayPath);
    // No power-user entry in tier_overrides → falls through to entry's own tier
    expect(power.templates.my_tool.approval_tier).toBe("auto-approve");
    const conservative = Catalog.load("conservative", overlayPath);
    // Per-entry override applies under the matching profile
    expect(conservative.templates.my_tool.approval_tier).toBe("human-confirm");
  });

  it("falls through to entry's own approval_tier when no blanket and no tier_overrides match", () => {
    const overlayPath = writeOverlay({
      templates: {
        unscored_tool: {
          approval_tier: "auto-approve",
          // no tier_overrides
        },
      },
    });
    const catalog = Catalog.load("standard", overlayPath);
    expect(catalog.templates.unscored_tool.approval_tier).toBe("auto-approve");
  });

  it("per-entry override on a default-catalog entry can be supplied via overlay", () => {
    // Overlay redeclares 'exec' with its own tier_overrides — overlay wins
    // on key collision, so the redeclared entry replaces the default's
    // semantics entirely.
    const overlayPath = writeOverlay({
      templates: {
        exec: {
          description: "Customized exec",
          approval_tier: "human-confirm",
          tier_overrides: {
            "power-user": "human-confirm", // refuse to relax even for power-user
          },
        },
      },
    });
    const catalog = Catalog.load("power-user", overlayPath);
    expect(catalog.templates.exec.approval_tier).toBe("human-confirm");
  });
});
