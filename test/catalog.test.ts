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

  it("buildDescription renders tool description when present", () => {
    const data: CatalogData = {
      templates: {
        exec: {
          description: "Execute shell commands in a sandbox.",
          parameter_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
          approval_tier: "human-confirm",
        },
      },
      images: {},
    };
    const desc = new Catalog(data, "standard").buildDescription();
    expect(desc).toContain("## exec [requires approval]");
    expect(desc).toContain("Execute shell commands in a sandbox.");
  });

  it("buildDescription renders action_hints and omits enum on action param", () => {
    const data: CatalogData = {
      templates: {
        browser: {
          description: "Control a headless browser.",
          action_hints: {
            "Navigation": "navigate, snapshot",
            "Interaction": "click, type",
          },
          parameter_schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["navigate", "snapshot", "click", "type"], description: "Browser action" },
              url: { type: "string", description: "URL to navigate to" },
            },
            required: ["action"],
          },
          approval_tier: "human-confirm",
        },
      },
      images: {},
    };
    const desc = new Catalog(data, "standard").buildDescription();
    // Action hints should be rendered as categories
    expect(desc).toContain("Actions:");
    expect(desc).toContain("  Navigation: navigate, snapshot");
    expect(desc).toContain("  Interaction: click, type");
    // action param should NOT have the enum values inline (they're in hints)
    expect(desc).not.toContain("navigate | snapshot | click | type");
    // action param should still show description
    expect(desc).toContain("- action (required): Browser action");
    // Other params render normally
    expect(desc).toContain("- url: URL to navigate to");
  });

  it("buildDescription shows array item type", () => {
    const data: CatalogData = {
      templates: {
        test: {
          parameter_schema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              data: { type: "array" },
            },
          },
          approval_tier: "auto-approve",
        },
      },
      images: {},
    };
    const desc = new Catalog(data, "standard").buildDescription();
    expect(desc).toContain("- tags (array of string)");
    expect(desc).toContain("- data (array)");
  });
});
