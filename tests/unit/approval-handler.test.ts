import { describe, it, expect, vi, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createApprovalNotifyHandler,
  createApprovalResolver,
  createApprovalCheckTool,
  getQueryParam,
  raceTimeout,
} from "../../src/approval-handler.js";
import { KernelClient } from "../../src/kernel-client.js";
import { pendingProposals } from "../../src/pending-store.js";
import type { ProposalResult, ApprovalResolution } from "../../src/kernel-client.js";
import plugin from "../../src/index.js";

afterEach(() => {
  pendingProposals.clear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake IncomingMessage with body and optional URL. */
function fakeReq(body: unknown, url?: string): IncomingMessage {
  const { Readable } = require("node:stream");
  const raw = JSON.stringify(body);
  const stream = new Readable({ read() { this.push(raw); this.push(null); } });
  (stream as any).url = url ?? "/safeclaw/approval-notify";
  return stream as IncomingMessage;
}

/** Create a fake ServerResponse capturing writeHead + end. */
function fakeRes() {
  const data: { statusCode?: number; body?: string } = {};
  return {
    writeHead(code: number) { data.statusCode = code; },
    end(body: string) { data.body = body; },
    data,
  } as unknown as ServerResponse & { data: typeof data };
}

// ---------------------------------------------------------------------------
// getQueryParam
// ---------------------------------------------------------------------------

describe("getQueryParam", () => {
  it("extracts a query parameter from URL path", () => {
    expect(
      getQueryParam("/safeclaw/notify?proposalId=abc-123", "proposalId"),
    ).toBe("abc-123");
  });

  it("returns null for missing key", () => {
    expect(
      getQueryParam("/safeclaw/notify?proposalId=abc-123", "other"),
    ).toBeNull();
  });

  it("returns null when no query string", () => {
    expect(getQueryParam("/safeclaw/notify", "proposalId")).toBeNull();
  });

  it("returns null for undefined url", () => {
    expect(getQueryParam(undefined, "proposalId")).toBeNull();
  });

  it("handles multiple query parameters", () => {
    const url = "/notify?proposalId=abc&action=exec&session=xyz";
    expect(getQueryParam(url, "proposalId")).toBe("abc");
    expect(getQueryParam(url, "action")).toBe("exec");
    expect(getQueryParam(url, "session")).toBe("xyz");
  });

  it("handles URL-encoded values", () => {
    expect(
      getQueryParam("/notify?key=hello%20world", "key"),
    ).toBe("hello world");
  });

  it("returns empty string for key with no value", () => {
    expect(getQueryParam("/notify?key=", "key")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// raceTimeout
// ---------------------------------------------------------------------------

describe("raceTimeout", () => {
  it("returns value when promise resolves before timeout", async () => {
    const result = await raceTimeout(Promise.resolve("done"), 1000);
    expect(result).toBe("done");
  });

  it("returns null when timeout fires first", async () => {
    const result = await raceTimeout(new Promise<string>(() => {}), 50);
    expect(result).toBeNull();
  });

  it("returns value for already-resolved promise", async () => {
    const result = await raceTimeout(Promise.resolve(42), 50);
    expect(result).toBe(42);
  });

  it("propagates rejection from the promise", async () => {
    await expect(raceTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// createApprovalNotifyHandler
// ---------------------------------------------------------------------------

describe("createApprovalNotifyHandler", () => {
  it("links approval_id via proposalId query param", async () => {
    pendingProposals.set("p-123", {
      promise: new Promise(() => {}),
      approvalId: null,
      action: "exec",
      params: { command: "ls" },
      createdAt: Date.now(),
    });

    const handler = createApprovalNotifyHandler();
    const req = fakeReq(
      { type: "approval_required", approval_id: "kernel-abc", template_name: "exec", proposal: {} },
      "/safeclaw/approval-notify?proposalId=p-123",
    );
    const res = fakeRes();
    await handler(req, res);

    expect(res.data.statusCode).toBe(200);
    expect(pendingProposals.get("p-123")!.approvalId).toBe("kernel-abc");
  });

  it("handles missing proposalId gracefully", async () => {
    const handler = createApprovalNotifyHandler();
    const req = fakeReq(
      { type: "approval_required", approval_id: "kernel-abc", template_name: "exec", proposal: {} },
    );
    const res = fakeRes();
    await handler(req, res);

    expect(res.data.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createApprovalResolver
// ---------------------------------------------------------------------------

describe("createApprovalResolver", () => {
  it("resolves via proposal_id lookup", async () => {
    const client = new KernelClient("http://localhost:7400");
    vi.spyOn(client, "resolveApproval").mockResolvedValue({
      approval_id: "kernel-abc",
      status: "approved",
    });

    pendingProposals.set("p-123", {
      promise: Promise.resolve({ status: "completed", result: { output: "done", output_vars: {} } }),
      approvalId: "kernel-abc",
      action: "exec",
      params: { command: "ls" },
      createdAt: Date.now(),
    });

    const resolver = createApprovalResolver(client);
    const result = await resolver({
      proposal_id: "p-123",
      decision: "approved",
    });

    expect(client.resolveApproval).toHaveBeenCalledWith("kernel-abc", expect.objectContaining({
      decision: "approved",
      decided_by: "user",
    }));
    expect(result).toHaveProperty("execution_result");
  });

  it("falls back to direct approval_id", async () => {
    const client = new KernelClient("http://localhost:7400");
    vi.spyOn(client, "resolveApproval").mockResolvedValue({
      approval_id: "direct-id",
      status: "approved",
    });

    const resolver = createApprovalResolver(client);
    await resolver({
      approval_id: "direct-id",
      decision: "approved",
    });

    expect(client.resolveApproval).toHaveBeenCalledWith("direct-id", expect.anything());
  });

  it("returns error when no approval_id available", async () => {
    const client = new KernelClient("http://localhost:7400");
    const resolver = createApprovalResolver(client);

    const result = await resolver({
      proposal_id: "nonexistent",
      decision: "approved",
    });

    expect(result).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// createApprovalCheckTool
// ---------------------------------------------------------------------------

describe("createApprovalCheckTool", () => {
  it("has correct tool shape", () => {
    const tool = createApprovalCheckTool();
    expect(tool.name).toBe("safeclaw_check");
    expect(tool.parameters.required).toEqual(["proposal_id"]);
  });

  it("returns result for completed proposal", async () => {
    const completed: ProposalResult = {
      status: "completed",
      result: { output: "file1.txt\nfile2.txt", output_vars: {}, exit_code: 0 },
    };
    pendingProposals.set("p-done", {
      promise: Promise.resolve(completed),
      approvalId: "kernel-abc",
      action: "exec",
      params: { command: "ls" },
      createdAt: Date.now(),
    });

    const tool = createApprovalCheckTool();
    const result = await tool.execute("call-1", { proposal_id: "p-done" });

    expect(result.content[0].text).toContain("file1.txt");
    expect(pendingProposals.has("p-done")).toBe(false);
  });

  it("returns unknown for expired proposal", async () => {
    const tool = createApprovalCheckTool();
    const result = await tool.execute("call-1", { proposal_id: "nonexistent" });

    expect(result.content[0].text).toContain("Unknown or expired");
  });

  it("returns error message on rejection", async () => {
    pendingProposals.set("p-err", {
      promise: Promise.reject(new Error("Connection refused")),
      approvalId: null,
      action: "exec",
      params: { command: "ls" },
      createdAt: Date.now(),
    });

    const tool = createApprovalCheckTool();
    const result = await tool.execute("call-1", { proposal_id: "p-err" });

    expect(result.content[0].text).toContain("[ERROR]");
    expect(result.content[0].text).toContain("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// /sc-approve decision paths — verify resolution construction
// ---------------------------------------------------------------------------

describe("/sc-approve decision paths", () => {
  /** Register the plugin and capture the /sc-approve handler. */
  function getScApproveHandler() {
    let commandHandler: ((ctx: { args?: string }) => Promise<{ text: string }>) | null = null;

    const mockApi: Record<string, any> = {
      pluginConfig: { kernelUrl: "http://localhost:7400" },
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCommand: vi.fn((cmd: any) => {
        if (cmd.name === "sc-approve") commandHandler = cmd.handler;
      }),
      on: vi.fn(),
    };

    plugin.register(mockApi);
    return commandHandler!;
  }

  /** Spy on KernelClient.resolveApproval via fetch mock, capturing the resolution body. */
  const originalFetch = globalThis.fetch;

  function mockFetch(): { getCapturedResolution: () => ApprovalResolution | null } {
    let captured: ApprovalResolution | null = null;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/approvals/") && urlStr.includes("/resolve")) {
        captured = JSON.parse(init.body);
        return { ok: true, json: async () => ({ status: "resolved" }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as any;
    return {
      getCapturedResolution: () => captured,
    };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("allow-once: remember=false, no match_pattern", async () => {
    const handler = getScApproveHandler();
    const { getCapturedResolution } = mockFetch();

    const completed: ProposalResult = {
      status: "completed",
      result: { output: "ok", output_vars: {}, exit_code: 0 },
    };
    pendingProposals.set("p-ao", {
      promise: Promise.resolve(completed),
      approvalId: "ap-1",
      action: "exec",
      params: { command: "git status" },
      createdAt: Date.now(),
    });

    await handler({ args: "p-ao allow-once" });

    const resolution = getCapturedResolution();
    expect(resolution).not.toBeNull();
    expect(resolution!.decision).toBe("approved");
    expect(resolution!.remember).toBe(false);
    expect(resolution!.match_pattern).toBeUndefined();
  });

  it("allow-always: remember=true + match_pattern present", async () => {
    const handler = getScApproveHandler();
    const { getCapturedResolution } = mockFetch();

    const completed: ProposalResult = {
      status: "completed",
      result: { output: "ok", output_vars: {}, exit_code: 0 },
    };
    pendingProposals.set("p-aa", {
      promise: Promise.resolve(completed),
      approvalId: "ap-2",
      action: "exec",
      params: { command: "git status" },
      createdAt: Date.now(),
    });

    await handler({ args: "p-aa allow-always" });

    const resolution = getCapturedResolution();
    expect(resolution).not.toBeNull();
    expect(resolution!.decision).toBe("approved");
    expect(resolution!.remember).toBe(true);
    expect(resolution!.match_pattern).toEqual({ command: "git *" });
  });

  it("deny: decision=denied, remember=false, no match_pattern", async () => {
    const handler = getScApproveHandler();
    const { getCapturedResolution } = mockFetch();

    pendingProposals.set("p-d", {
      promise: new Promise(() => {}),
      approvalId: "ap-3",
      action: "exec",
      params: { command: "rm -rf /" },
      createdAt: Date.now(),
    });

    const result = await handler({ args: "p-d deny" });

    const resolution = getCapturedResolution();
    expect(resolution).not.toBeNull();
    expect(resolution!.decision).toBe("denied");
    expect(resolution!.remember).toBe(false);
    expect(resolution!.match_pattern).toBeUndefined();
    expect(result.text).toContain("Denied");
    expect(result.text).not.toContain("remembered");
  });

  it("deny-always: decision=denied, remember=true + match_pattern", async () => {
    const handler = getScApproveHandler();
    const { getCapturedResolution } = mockFetch();

    pendingProposals.set("p-da", {
      promise: new Promise(() => {}),
      approvalId: "ap-4",
      action: "exec",
      params: { command: "rm -rf /" },
      createdAt: Date.now(),
    });

    const result = await handler({ args: "p-da deny-always" });

    const resolution = getCapturedResolution();
    expect(resolution).not.toBeNull();
    expect(resolution!.decision).toBe("denied");
    expect(resolution!.remember).toBe(true);
    expect(resolution!.match_pattern).toEqual({ command: "rm *" });
    expect(result.text).toContain("remembered");
    expect(result.text).toContain("rm *");
  });
});

// ---------------------------------------------------------------------------
// /sc-policies command — verify list + revoke
// ---------------------------------------------------------------------------

describe("/sc-policies command", () => {
  function getScPoliciesHandler() {
    let commandHandler: ((ctx: { args?: string }) => Promise<{ text: string }>) | null = null;

    const mockApi: Record<string, any> = {
      pluginConfig: { kernelUrl: "http://localhost:7400" },
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerCommand: vi.fn((cmd: any) => {
        if (cmd.name === "sc-policies") commandHandler = cmd.handler;
      }),
      on: vi.fn(),
    };

    plugin.register(mockApi);
    return commandHandler!;
  }

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lists rules in table format", async () => {
    const handler = getScPoliciesHandler();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        rules: [
          {
            rule_id: "abc12345-full-uuid",
            template_name: "exec",
            match_pattern: { command: "git *" },
            scope: "allow",
            created_from: "test",
            created_at: new Date(Date.now() - 3600_000).toISOString(),
          },
        ],
      }),
    })) as any;

    const result = await handler({ args: "" });
    expect(result.text).toContain("Learned policy rules");
    expect(result.text).toContain("abc12345");
    expect(result.text).toContain("exec");
    expect(result.text).toContain("allow");
    expect(result.text).toContain("git *");
    expect(result.text).toContain("1h");
  });

  it("shows empty message when no rules", async () => {
    const handler = getScPoliciesHandler();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ rules: [] }),
    })) as any;

    const result = await handler({ args: "" });
    expect(result.text).toBe("No learned policy rules.");
  });

  it("revokes a rule by ID", async () => {
    const handler = getScPoliciesHandler();
    let deletedPath: string | null = null;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const urlStr = String(url);
      if (init?.method === "DELETE" && urlStr.includes("/api/policies/")) {
        deletedPath = urlStr;
        return { ok: true, json: async () => ({ deleted: true }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as any;

    const result = await handler({ args: "revoke rule-xyz" });
    expect(result.text).toContain("rule-xyz");
    expect(result.text).toContain("revoked");
    expect(deletedPath).toContain("/api/policies/rule-xyz");
  });

  it("returns usage when revoke has no rule ID", async () => {
    const handler = getScPoliciesHandler();
    const result = await handler({ args: "revoke" });
    expect(result.text).toContain("Usage");
  });

  it("handles API errors gracefully", async () => {
    const handler = getScPoliciesHandler();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    })) as any;

    const result = await handler({ args: "" });
    expect(result.text).toContain("Failed to list policies");
  });
});
