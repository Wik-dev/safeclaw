import { describe, it, expect, vi, afterEach } from "vitest";
import { createSafeClawTool } from "../src/meta-tool.js";
import { Catalog, type CatalogData } from "../src/catalog.js";
import { KernelClient } from "../src/kernel-client.js";
import { pendingProposals } from "../src/pending-store.js";

const AUTO_CATALOG: CatalogData = {
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
      approval_tier: "auto-approve",
    },
  },
  images: { sandbox: "validance-sandbox:latest" },
};

const CONFIRM_CATALOG: CatalogData = {
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

afterEach(() => {
  pendingProposals.clear();
});

describe("createSafeClawTool", () => {
  it("creates a tool with correct name and parameters", () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(AUTO_CATALOG, "standard");

    const tool = createSafeClawTool(client, catalog, {
      kernelUrl: "http://localhost:7400",
    }, "/workspace");

    expect(tool.name).toBe("safeclaw");
    expect(tool.parameters.properties.action.enum).toContain("exec");
    expect(tool.parameters.required).toEqual(["action", "params"]);
  });

  it("auto-approve: blocks and returns formatted result", async () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(AUTO_CATALOG, "standard");

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

  it("auto-approve: formats denied result", async () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(AUTO_CATALOG, "standard");

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

  it("human-confirm: returns approval prompt immediately", async () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(CONFIRM_CATALOG, "standard");

    // submitProposal should be called but NOT awaited by the tool
    const neverResolves = new Promise<any>(() => {});
    vi.spyOn(client, "submitProposal").mockReturnValue(neverResolves);

    const tool = createSafeClawTool(client, catalog, {
      kernelUrl: "http://localhost:7400",
    }, "/workspace");

    const result = await tool.execute("call-3", {
      action: "exec",
      params: { command: "ls /tmp" },
    });

    // Should return immediately (not hang on the never-resolving promise)
    expect(result.content[0].text).toContain("Action requires approval");
    expect(result.content[0].text).toContain("/sc-approve");
    expect(result.content[0].text).toContain("ls /tmp");

    // Should have stored in pending
    expect(pendingProposals.size).toBe(1);
    const [proposalId, entry] = [...pendingProposals.entries()][0];
    expect(entry.action).toBe("exec");
    expect(entry.params).toEqual({ command: "ls /tmp" });
    expect(result.content[0].text).toContain(proposalId);
  });

  it("human-confirm: includes proposalId in notify_url", async () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(CONFIRM_CATALOG, "standard");

    const neverResolves = new Promise<any>(() => {});
    const spy = vi.spyOn(client, "submitProposal").mockReturnValue(neverResolves);

    const tool = createSafeClawTool(client, catalog, {
      kernelUrl: "http://localhost:7400",
    }, "/workspace");

    await tool.execute("call-4", {
      action: "exec",
      params: { command: "ls" },
    });

    const call = spy.mock.calls[0][0];
    expect(call.notify_url).toContain("?proposalId=");
  });
});
