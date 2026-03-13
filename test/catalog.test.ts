import { describe, it, expect } from "vitest";
import { Catalog, type CatalogData } from "../src/catalog.js";

const MINIMAL_CATALOG: CatalogData = {
  templates: {
    exec: {
      persistent: true,
      docker_image: "sandbox",
      command_template: "sh -c '{command}'",
      parameter_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
      approval_tier: "human-confirm",
      timeout: 120,
      rate_limit: 200,
    },
    write: {
      persistent: false,
      docker_image: "sandbox",
      command_template: "write '{path}'",
      approval_tier: "auto-approve",
    },
    gateway: {
      approval_tier: "always-deny",
    },
  },
  images: {
    sandbox: "validance-sandbox:latest",
  },
};

describe("Catalog", () => {
  it("loads with standard profile (no overrides)", () => {
    const catalog = new Catalog(MINIMAL_CATALOG, "standard");
    expect(catalog.templates.exec.approval_tier).toBe("human-confirm");
    expect(catalog.templates.write.approval_tier).toBe("auto-approve");
    expect(catalog.templates.gateway.approval_tier).toBe("always-deny");
  });

  it("power-user profile overrides exec to auto-approve", () => {
    const catalog = new Catalog(MINIMAL_CATALOG, "power-user");
    expect(catalog.templates.exec.approval_tier).toBe("auto-approve");
  });

  it("conservative profile overrides write to human-confirm", () => {
    const catalog = new Catalog(MINIMAL_CATALOG, "conservative");
    expect(catalog.templates.write.approval_tier).toBe("human-confirm");
  });

  it("actionNames excludes always-deny templates", () => {
    const catalog = new Catalog(MINIMAL_CATALOG, "standard");
    const names = catalog.actionNames();
    expect(names).toContain("exec");
    expect(names).toContain("write");
    expect(names).not.toContain("gateway");
  });

  it("buildDescription includes action names and parameter info", () => {
    const catalog = new Catalog(MINIMAL_CATALOG, "standard");
    const desc = catalog.buildDescription();
    expect(desc).toContain("exec");
    expect(desc).toContain("requires approval");
    expect(desc).toContain("command");
    expect(desc).not.toContain("gateway");
  });
});
