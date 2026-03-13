import { describe, it, expect, vi } from "vitest";
import {
  createApprovalNotifyHandler,
  createApprovalResolver,
} from "../src/approval-handler.js";
import { KernelClient } from "../src/kernel-client.js";

describe("createApprovalNotifyHandler", () => {
  it("broadcasts approval notification and responds", async () => {
    const broadcastCalls: any[] = [];
    const api = {
      runtime: {
        broadcast: (event: string, data: any) => {
          broadcastCalls.push({ event, data });
        },
      },
    };

    const handler = createApprovalNotifyHandler(api);

    const req = {
      body: {
        type: "approval_required",
        approval_id: "abc123",
        template_name: "exec",
        proposal: { parameters: { command: "ls" } },
      },
    };
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0].event).toBe("safeclaw:approval");
    expect(broadcastCalls[0].data.approval_id).toBe("abc123");
    expect(broadcastCalls[0].data.message).toContain("exec");
  });
});

describe("createApprovalResolver", () => {
  it("calls client.resolveApproval with correct params", async () => {
    const client = new KernelClient("http://localhost:7400");
    vi.spyOn(client, "resolveApproval").mockResolvedValue({
      approval_id: "abc123",
      status: "approved",
    });

    const resolver = createApprovalResolver(client);
    const result = await resolver({
      approval_id: "abc123",
      decision: "approved",
      remember: true,
      match_pattern: { command: "git *" },
      reason: "Trust git commands",
    });

    expect(client.resolveApproval).toHaveBeenCalledWith("abc123", {
      decision: "approved",
      reason: "Trust git commands",
      decided_by: "user",
      remember: true,
      match_pattern: { command: "git *" },
    });
  });
});
