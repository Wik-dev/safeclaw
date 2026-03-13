import { describe, it, expect, vi } from "vitest";
import { createSafeClawTool } from "../src/meta-tool.js";
import { Catalog, type CatalogData } from "../src/catalog.js";
import { KernelClient } from "../src/kernel-client.js";

const MINIMAL_CATALOG: CatalogData = {
  templates: {
    exec: {
      persistent: true,
      docker_image: "sandbox",
      command_template: "sh -c '{command}'",
      parameter_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      approval_tier: "human-confirm",
    },
  },
  images: { sandbox: "validance-sandbox:latest" },
};

describe("createSafeClawTool", () => {
  it("creates a tool with correct name and parameters", () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(MINIMAL_CATALOG, "standard");

    const tool = createSafeClawTool(client, catalog, {
      kernelUrl: "http://localhost:7400",
    }, "/workspace");

    expect(tool.name).toBe("safeclaw");
    expect(tool.parameters.properties.action.enum).toContain("exec");
    expect(tool.parameters.required).toEqual(["action", "params"]);
  });

  it("execute returns formatted text result", async () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(MINIMAL_CATALOG, "standard");

    // Mock submitProposal
    vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: {
        output: "hello world",
        output_vars: {},
        exit_code: 0,
      },
    });

    const tool = createSafeClawTool(client, catalog, {
      kernelUrl: "http://localhost:7400",
    }, "/workspace");

    const result = await tool.execute("call-1", {
      action: "exec",
      params: { command: "echo hello world" },
    });

    expect(result.content[0].text).toContain("hello world");
  });

  it("execute formats denied result", async () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(MINIMAL_CATALOG, "standard");

    vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "denied",
      reason: "Action denied by policy",
    });

    const tool = createSafeClawTool(client, catalog, {
      kernelUrl: "http://localhost:7400",
    }, "/workspace");

    const result = await tool.execute("call-2", {
      action: "exec",
      params: { command: "rm -rf /" },
    });

    expect(result.content[0].text).toContain("[DENIED]");
  });
});
