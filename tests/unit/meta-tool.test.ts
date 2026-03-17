import { describe, it, expect } from "vitest";
import { formatResult } from "../../src/meta-tool.js";
import type { ProposalResult } from "../../src/kernel-client.js";

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
