import { describe, it, expect, vi, beforeEach } from "vitest";
import { KernelClient } from "../src/kernel-client.js";

describe("KernelClient", () => {
  let client: KernelClient;

  beforeEach(() => {
    client = new KernelClient("http://localhost:7400");
  });

  it("strips trailing slash from base URL", () => {
    const c = new KernelClient("http://localhost:7400/");
    expect((c as any).baseUrl).toBe("http://localhost:7400");
  });

  it("healthCheck returns false on network error", async () => {
    // No server running — should return false, not throw
    const result = await client.healthCheck();
    expect(result).toBe(false);
  });

  it("submitProposal throws on non-200 response", async () => {
    // Mock fetch to return 400
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad request"),
    }) as any;

    try {
      await expect(
        client.submitProposal({
          action: "exec",
          parameters: { command: "ls" },
          session_hash: "test",
        }),
      ).rejects.toThrow("Kernel /api/proposals failed (400)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("submitProposal returns rate_limited without throwing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({
          status: "rate_limited",
          reason: "Too many requests",
        }),
    }) as any;

    try {
      const result = await client.submitProposal({
        action: "exec",
        parameters: { command: "ls" },
        session_hash: "test",
      });
      expect(result.status).toBe("rate_limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
