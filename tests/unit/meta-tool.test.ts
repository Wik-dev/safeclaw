import { describe, it, expect } from "vitest";
import { formatResult, createSafeClawTool } from "../../src/meta-tool.js";
import { Catalog, type CatalogData } from "../../src/catalog.js";
import { KernelClient } from "../../src/kernel-client.js";
import type { ProposalResult } from "../../src/kernel-client.js";

// ---------------------------------------------------------------------------
// Tool shape
// ---------------------------------------------------------------------------

describe("createSafeClawTool shape", () => {
  const FIXTURE: CatalogData = {
    templates: {
      exec: {
        approval_tier: "human-confirm",
        parameter_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      write: {
        approval_tier: "auto-approve",
        parameter_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    images: {},
  };

  it("creates a tool named 'safeclaw' with flat parameter schema (no oneOf)", () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(FIXTURE, "standard");
    const tool = createSafeClawTool(client, catalog, { kernelUrl: "http://localhost:7400" }, "/ws");

    expect(tool.name).toBe("safeclaw");

    // No oneOf — flat object schema
    expect(tool.parameters.oneOf).toBeUndefined();
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.required).toEqual(["action", "params"]);

    // action is an enum of all action names
    const actionProp = (tool.parameters as any).properties.action;
    expect(actionProp.type).toBe("string");
    expect(actionProp.enum.sort()).toEqual(["exec", "write"]);

    // params has merged properties from all actions
    const paramProps = (tool.parameters as any).properties.params.properties;
    expect(paramProps).toHaveProperty("command");
    expect(paramProps).toHaveProperty("path");
    expect(paramProps).toHaveProperty("content");
  });
});

describe("createSafeClawTool fleet input_files schema", () => {
  const FLEET_FIXTURE: CatalogData = {
    templates: {
      fleet_underclock: {
        approval_tier: "human-confirm",
        parameter_schema: {
          type: "object",
          properties: {
            device_id: { type: "string" },
            target_pct: { type: "number" },
            reason: { type: "string" },
            input_files: {
              type: "object",
              description: "File references for fleet data.",
              additionalProperties: { type: "string" },
            },
          },
          required: ["device_id", "target_pct", "reason"],
        },
      },
      fleet_status_query: {
        approval_tier: "auto-approve",
        parameter_schema: {
          type: "object",
          properties: {
            query_type: { type: "string" },
            input_files: {
              type: "object",
              description: "File references for fleet data.",
              additionalProperties: { type: "string" },
            },
          },
          required: ["query_type"],
        },
      },
    },
    images: {},
  };

  it("includes input_files in merged params schema for fleet templates", () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(FLEET_FIXTURE, "standard");
    const tool = createSafeClawTool(client, catalog, { kernelUrl: "http://localhost:7400" }, "/ws");

    const paramProps = (tool.parameters as any).properties.params.properties;
    expect(paramProps).toHaveProperty("input_files");
    expect(paramProps.input_files.type).toBe("object");
    // Also has props from both templates
    expect(paramProps).toHaveProperty("device_id");
    expect(paramProps).toHaveProperty("query_type");
  });

  it("params has no required array (all optional in merged schema)", () => {
    const client = new KernelClient("http://localhost:7400");
    const catalog = new Catalog(FLEET_FIXTURE, "standard");
    const tool = createSafeClawTool(client, catalog, { kernelUrl: "http://localhost:7400" }, "/ws");

    // No required on params — different actions need different params
    const paramsSchema = (tool.parameters as any).properties.params;
    expect(paramsSchema.required).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatResult
// ---------------------------------------------------------------------------

describe("formatResult", () => {
  it("denied → [DENIED] with reason", () => {
    const r: ProposalResult = { status: "denied", reason: "Policy violation" };
    expect(formatResult(r)).toBe("[DENIED] Policy violation");
  });

  it("denied → default message when no reason", () => {
    const r: ProposalResult = { status: "denied" };
    expect(formatResult(r)).toBe("[DENIED] Action was denied");
  });

  it("rate_limited → [RATE LIMITED] with reason", () => {
    const r: ProposalResult = {
      status: "rate_limited",
      reason: "5 per minute exceeded",
    };
    expect(formatResult(r)).toBe("[RATE LIMITED] 5 per minute exceeded");
  });

  it("rate_limited → default message when no reason", () => {
    const r: ProposalResult = { status: "rate_limited" };
    expect(formatResult(r)).toBe("[RATE LIMITED] Rate limit exceeded");
  });

  it("failed → [FAILED] with error and output", () => {
    const r: ProposalResult = {
      status: "failed",
      result: { output: "stderr here", output_vars: {}, error: "exit code 1" },
    };
    expect(formatResult(r)).toBe("[FAILED] exit code 1\nstderr here");
  });

  it("failed → [FAILED] with error only", () => {
    const r: ProposalResult = {
      status: "failed",
      result: { output: "", output_vars: {}, error: "timeout" },
    };
    expect(formatResult(r)).toBe("[FAILED] timeout");
  });

  it("failed → [FAILED] Unknown error when no result", () => {
    const r: ProposalResult = { status: "failed" };
    expect(formatResult(r)).toBe("[FAILED] Unknown error");
  });

  it("completed with output → output text", () => {
    const r: ProposalResult = {
      status: "completed",
      result: { output: "Hello, world!", output_vars: {} },
    };
    expect(formatResult(r)).toBe("Hello, world!");
  });

  it("completed with output_vars → includes JSON", () => {
    const r: ProposalResult = {
      status: "completed",
      result: {
        output: "Done",
        output_vars: { count: 42 },
      },
    };
    const text = formatResult(r);
    expect(text).toContain("Done");
    expect(text).toContain("Output variables:");
    expect(text).toContain('"count":42');
  });

  it("completed with only output_vars (no output text) → just vars", () => {
    const r: ProposalResult = {
      status: "completed",
      result: { output: "", output_vars: { key: "value" } },
    };
    const text = formatResult(r);
    expect(text).toContain("Output variables:");
    expect(text).toContain('"key":"value"');
  });

  it("completed with no result → fallback message", () => {
    const r: ProposalResult = { status: "completed" };
    expect(formatResult(r)).toBe("[COMPLETED] (no output)");
  });

  it("completed with empty result → fallback message", () => {
    const r: ProposalResult = {
      status: "completed",
      result: { output: "", output_vars: {} },
    };
    expect(formatResult(r)).toBe("[COMPLETED] (no output)");
  });
});
