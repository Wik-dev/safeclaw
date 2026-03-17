import { describe, it, expect } from "vitest";
import { Catalog } from "../../src/catalog.js";
import type { CatalogData, TemplateEntry } from "../../src/catalog.js";

/** Minimal catalog fixture for testing. */
function makeFixture(): CatalogData {
  return {
    templates: {
      exec: {
        description: "Execute a shell command",
        approval_tier: "human-confirm",
        parameter_schema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Shell command to run",
            },
          },
          required: ["command"],
        },
      } as TemplateEntry,
      write: {
        description: "Write a file",
        approval_tier: "auto-approve",
        parameter_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" },
          },
          required: ["path", "content"],
        },
      } as TemplateEntry,
      browser: {
        description: "Browser automation",
        approval_tier: "human-confirm",
        action_hints: {
          navigation: "goto, back, forward",
          interaction: "click, type, scroll",
        },
        parameter_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["goto", "click", "type"],
              description: "Browser action",
            },
            url: { type: "string", description: "Target URL" },
          },
          required: ["action"],
        },
      } as TemplateEntry,
      web_fetch: {
        description: "Fetch a URL",
        approval_tier: "auto-approve",
        parameter_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
            headers: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["url"],
        },
      } as TemplateEntry,
      gateway: {
        approval_tier: "always-deny",
      } as TemplateEntry,
    },
    images: {
      "task-sandbox": "validance/sandbox:latest",
      "task-browser": "validance/browser:latest",
    },
  };
}

describe("Catalog constructor", () => {
  it("copies templates from input data", () => {
    const catalog = new Catalog(makeFixture());
    expect(catalog.templates.exec).toBeDefined();
    expect(catalog.templates.write).toBeDefined();
    expect(catalog.templates.gateway).toBeDefined();
  });

  it("copies images from input data", () => {
    const catalog = new Catalog(makeFixture());
    expect(catalog.images["task-sandbox"]).toBe("validance/sandbox:latest");
  });

  it("standard profile preserves original tiers", () => {
    const catalog = new Catalog(makeFixture(), "standard");
    expect(catalog.templates.exec.approval_tier).toBe("human-confirm");
    expect(catalog.templates.write.approval_tier).toBe("auto-approve");
  });

  it("conservative profile overrides all to human-confirm", () => {
    const catalog = new Catalog(makeFixture(), "conservative");
    expect(catalog.templates.exec.approval_tier).toBe("human-confirm");
    expect(catalog.templates.write.approval_tier).toBe("human-confirm");
    expect(catalog.templates.browser.approval_tier).toBe("human-confirm");
    expect(catalog.templates.web_fetch.approval_tier).toBe("human-confirm");
    expect(catalog.templates.gateway.approval_tier).toBe("always-deny");
  });

  it("power-user profile overrides exec and browser to auto-approve", () => {
    const catalog = new Catalog(makeFixture(), "power-user");
    expect(catalog.templates.exec.approval_tier).toBe("auto-approve");
    expect(catalog.templates.browser.approval_tier).toBe("auto-approve");
    // write stays as-is (already auto-approve)
    expect(catalog.templates.write.approval_tier).toBe("auto-approve");
  });

  it("does not mutate the input data", () => {
    const data = makeFixture();
    new Catalog(data, "power-user");
    expect(data.templates.exec.approval_tier).toBe("human-confirm");
  });
});

describe("actionNames", () => {
  it("excludes always-deny templates", () => {
    const catalog = new Catalog(makeFixture());
    const names = catalog.actionNames();
    expect(names).not.toContain("gateway");
  });

  it("returns sorted names", () => {
    const catalog = new Catalog(makeFixture());
    const names = catalog.actionNames();
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("includes all non-denied templates", () => {
    const catalog = new Catalog(makeFixture());
    const names = catalog.actionNames();
    expect(names).toContain("exec");
    expect(names).toContain("write");
    expect(names).toContain("browser");
    expect(names).toContain("web_fetch");
    expect(names).toHaveLength(4);
  });

  it("conservative profile with always-deny still excludes it", () => {
    const catalog = new Catalog(makeFixture(), "conservative");
    const names = catalog.actionNames();
    expect(names).not.toContain("gateway");
  });
});

describe("buildDescription", () => {
  it("starts with the meta-tool header", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    expect(desc).toContain("Execute actions in isolated containers");
  });

  it("includes section headers for each action", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    expect(desc).toContain("## exec");
    expect(desc).toContain("## write");
    expect(desc).toContain("## browser");
    expect(desc).toContain("## web_fetch");
  });

  it("does not include always-deny actions", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    expect(desc).not.toContain("## gateway");
  });

  it("marks human-confirm actions with [requires approval]", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    expect(desc).toContain("## exec [requires approval]");
    expect(desc).toContain("## browser [requires approval]");
    // auto-approve actions should NOT have the tag
    expect(desc).not.toContain("## write [requires approval]");
  });

  it("includes parameter descriptions with (required) marker", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    expect(desc).toContain("- command (required): Shell command to run");
    expect(desc).toContain("- path (required): File path");
  });

  it("includes action_hints as grouped actions", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    expect(desc).toContain("Actions:");
    expect(desc).toContain("navigation: goto, back, forward");
    expect(desc).toContain("interaction: click, type, scroll");
  });

  it("shows enum values for non-hinted params", () => {
    // web_fetch has no action_hints, so enum values should show inline
    const data = makeFixture();
    // Add an enum to a non-hinted template for testing
    (data.templates.write.parameter_schema as any).properties.mode = {
      type: "string",
      enum: ["overwrite", "append"],
      description: "Write mode",
    };
    const catalog = new Catalog(data);
    const desc = catalog.buildDescription();
    expect(desc).toContain("overwrite | append");
  });

  it("shows array item type hint", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    // web_fetch has headers: array of string
    expect(desc).toContain("(array of string)");
  });

  it("includes template description text", () => {
    const catalog = new Catalog(makeFixture());
    const desc = catalog.buildDescription();
    expect(desc).toContain("Execute a shell command");
    expect(desc).toContain("Browser automation");
  });
});
