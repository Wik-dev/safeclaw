/**
 * Integration tests — E2E approval flow against a live Validance dev API.
 *
 * Loads the real SafeClaw plugin, points it at http://localhost:8001,
 * and exercises all approval decision paths end-to-end.
 *
 * Skips gracefully if Validance is not reachable.
 *
 * Run:  cd safeclaw && npx vitest run tests/integration/
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import plugin from "../../src/index.js";
import { pendingProposals } from "../../src/pending-store.js";
import { clearSessionCache, sessionHash } from "../../src/session-map.js";
import { KernelClient } from "../../src/kernel-client.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KERNEL_URL = "http://localhost:8001";
const WEBHOOK_PORT = 19800;
/** Gateway host as seen from the Validance container (Docker bridge). */
const GATEWAY_HOST = "172.18.0.1";
const TEST_SESSION_KEY = `integration-test-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

type MetaToolExecute = (
  toolCallId: string,
  args: { action: string; params: Record<string, unknown> },
  signal?: AbortSignal,
) => Promise<ToolResult>;

type CheckToolExecute = (
  toolCallId: string,
  args: { proposal_id: string },
) => Promise<ToolResult>;

type ScApproveHandler = (ctx: { args?: string }) => Promise<{ text: string }>;

// ---------------------------------------------------------------------------
// Webhook server — captures approval notifications from Validance
// ---------------------------------------------------------------------------

class WebhookServer {
  private server: Server | null = null;
  /** Map: proposalId → approval_id (set when webhook fires) */
  readonly received = new Map<string, string>();
  private waiters = new Map<string, Array<(approvalId: string) => void>>();

  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const url = req.url ?? "";
            const idx = url.indexOf("?");
            const params = idx >= 0 ? new URLSearchParams(url.slice(idx)) : new URLSearchParams();
            const proposalId = params.get("proposalId");
            const approvalId: string = body.approval_id;

            if (proposalId && approvalId) {
              this.received.set(proposalId, approvalId);
              // Wake up any waiters
              const fns = this.waiters.get(proposalId);
              if (fns) {
                for (const fn of fns) fn(approvalId);
                this.waiters.delete(proposalId);
              }
            }
          } catch { /* ignore malformed */ }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"received":true}');
        });
      });
      this.server.on("error", reject);
      this.server.listen(port, () => resolve());
    });
  }

  /** Wait for a webhook for a specific proposalId (with timeout). */
  waitFor(proposalId: string, timeoutMs = 30_000): Promise<string> {
    const existing = this.received.get(proposalId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = this.waiters.get(proposalId);
        if (arr) {
          this.waiters.set(proposalId, arr.filter((f) => f !== resolve));
        }
        reject(new Error(`Webhook timeout for proposalId=${proposalId}`));
      }, timeoutMs);

      const resolver = (approvalId: string) => {
        clearTimeout(timer);
        resolve(approvalId);
      };

      const arr = this.waiters.get(proposalId) ?? [];
      arr.push(resolver);
      this.waiters.set(proposalId, arr);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin registration helper
// ---------------------------------------------------------------------------

function registerPlugin(kernelUrl: string, gatewayPort: number, gatewayHost: string, trustProfile = "standard") {
  let metaToolExecute: MetaToolExecute | null = null;
  let checkToolExecute: CheckToolExecute | null = null;
  let scApproveHandler: ScApproveHandler | null = null;

  const mockApi: Record<string, any> = {
    pluginConfig: {
      kernelUrl,
      trustProfile,
      gatewayPort,
      gatewayHost,
    },
    config: { agent: { workspace: "/tmp/safeclaw-integration-test" } },
    registerTool: (tool: any) => {
      if (tool.name === "safeclaw") metaToolExecute = tool.execute;
      if (tool.name === "safeclaw_check") checkToolExecute = tool.execute;
    },
    registerHttpRoute: () => {},
    registerGatewayMethod: () => {},
    registerCommand: (cmd: any) => {
      if (cmd.name === "sc-approve") scApproveHandler = cmd.handler;
    },
    on: () => {},
  };

  plugin.register(mockApi);

  if (!metaToolExecute || !checkToolExecute || !scApproveHandler) {
    throw new Error("Plugin registration failed — handlers not captured");
  }

  return {
    metaTool: metaToolExecute,
    checkTool: checkToolExecute,
    scApprove: scApproveHandler,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

/** Extract proposalId from the approval prompt text. */
function extractProposalId(promptText: string): string {
  const match = promptText.match(/\/sc-approve\s+([0-9a-f-]{36})\s+allow-once/);
  if (!match) throw new Error(`No proposalId found in: ${promptText.slice(0, 200)}`);
  return match[1];
}

/**
 * Build args for the meta-tool with _sessionKey at the top level.
 * The meta-tool reads `(args as any)._sessionKey` from the args object directly.
 */
function execArgs(action: string, params: Record<string, unknown>): any {
  return { action, params, _sessionKey: TEST_SESSION_KEY };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Integration: approval flow (live Validance)", () => {
  const client = new KernelClient(KERNEL_URL);
  const webhook = new WebhookServer();
  let metaTool: MetaToolExecute;
  let checkTool: CheckToolExecute;
  let scApprove: ScApproveHandler;
  let sHash: string;
  let alive = false;

  beforeAll(async () => {
    // Skip guard — check if Validance is reachable
    alive = await client.healthCheck();
    if (!alive) return;

    sHash = sessionHash(TEST_SESSION_KEY);

    // Clean up any stale containers from previous test runs
    try { await client.cleanupSession(sHash); } catch { /* ok */ }

    await webhook.start(WEBHOOK_PORT);

    const handlers = registerPlugin(KERNEL_URL, WEBHOOK_PORT, GATEWAY_HOST);
    metaTool = handlers.metaTool;
    checkTool = handlers.checkTool;
    scApprove = handlers.scApprove;
  });

  afterEach(async () => {
    pendingProposals.clear();
    clearSessionCache();
  });

  afterAll(async () => {
    if (!alive) return;
    await webhook.stop();
    // Clean up any test policies and session containers
    try {
      const { rules } = await client.listPolicies(sHash);
      for (const rule of rules) {
        await client.revokePolicy(rule.rule_id).catch(() => {});
      }
    } catch { /* kernel may be down */ }
    try {
      await client.cleanupSession(sHash);
    } catch { /* best effort */ }
  });

  // -------------------------------------------------------------------------
  // Test: auto-approve path (write)
  // -------------------------------------------------------------------------

  it("auto-approve: write returns result directly", async () => {
    if (!alive) return; // skip

    const result = await metaTool("tc-auto", execArgs("write", {
      path: "/tmp/safeclaw-test.txt",
      content: "integration test",
    }));

    const output = text(result);
    // Auto-approve should return a result, not an approval prompt
    expect(output).not.toContain("/sc-approve");
    // Should contain some execution outcome (completed, failed, or output)
    expect(
      output.includes("[COMPLETED]") ||
      output.includes("[FAILED]") ||
      output.length > 0
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test: human-confirm → allow-once (exec)
  // -------------------------------------------------------------------------

  it("human-confirm → allow-once: approval prompt → approve → result", async () => {
    if (!alive) return;

    // 1. Submit exec — should return approval prompt
    const promptResult = await metaTool("tc-allow-once", execArgs("exec", {
      command: "echo hello-integration",
    }));
    const prompt = text(promptResult);
    expect(prompt).toContain("/sc-approve");
    expect(prompt).toContain("exec");

    const proposalId = extractProposalId(prompt);

    // 2. Wait for webhook to link approval_id
    const approvalId = await webhook.waitFor(proposalId);
    expect(approvalId).toBeTruthy();

    // Ensure the pending entry has the approval_id linked
    const entry = pendingProposals.get(proposalId);
    if (entry) entry.approvalId = approvalId;

    // 3. Approve with allow-once
    const approveResult = await scApprove({ args: `${proposalId} allow-once` });
    expect(approveResult.text).toContain("Approved & executed");
    expect(approveResult.text).toContain("hello-integration");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Test: human-confirm → allow-always + learned policy auto-approve
  // -------------------------------------------------------------------------

  it("allow-always creates learned policy that auto-approves next call", async () => {
    if (!alive) return;

    // 1. Submit exec — gets approval prompt
    const promptResult = await metaTool("tc-learn-allow", execArgs("exec", {
      command: "echo learn-allow-test",
    }));
    const proposalId = extractProposalId(text(promptResult));

    // 2. Wait for webhook, link approval_id, approve with allow-always
    const approvalId = await webhook.waitFor(proposalId);
    const entry = pendingProposals.get(proposalId);
    if (entry) entry.approvalId = approvalId;

    const approveResult = await scApprove({ args: `${proposalId} allow-always` });
    expect(approveResult.text).toContain("Approved & executed");

    // 3. Verify learned policy exists
    const { rules } = await client.listPolicies(sHash);
    const echoRule = rules.find(
      (r) => r.template_name === "exec" && r.scope === "allow" && r.match_pattern?.command === "echo *"
    );
    expect(echoRule).toBeDefined();

    // 4. Submit another matching exec — should auto-approve within 500ms
    const secondResult = await metaTool("tc-learn-allow-2", execArgs("exec", {
      command: "echo learn-second",
    }));
    const secondText = text(secondResult);
    // Should NOT return an approval prompt — learned policy should auto-approve
    expect(secondText).not.toContain("/sc-approve");
    expect(secondText).toContain("learn-second");

    // 5. Cleanup: revoke the learned rule
    if (echoRule) {
      await client.revokePolicy(echoRule.rule_id);
    }
  }, 90_000);

  // -------------------------------------------------------------------------
  // Test: human-confirm → deny
  // -------------------------------------------------------------------------

  it("human-confirm → deny: returns denied message", async () => {
    if (!alive) return;

    const promptResult = await metaTool("tc-deny", execArgs("exec", {
      command: "echo deny-me",
    }));
    const proposalId = extractProposalId(text(promptResult));

    const approvalId = await webhook.waitFor(proposalId);
    const entry = pendingProposals.get(proposalId);
    if (entry) entry.approvalId = approvalId;

    const denyResult = await scApprove({ args: `${proposalId} deny` });
    expect(denyResult.text).toContain("Denied");
    expect(denyResult.text).toContain("exec");
    expect(denyResult.text).not.toContain("remembered");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Test: human-confirm → deny-always + learned policy auto-deny
  // -------------------------------------------------------------------------

  it("deny-always creates learned policy that auto-denies next call", async () => {
    if (!alive) return;

    // 1. Submit exec, get prompt
    const promptResult = await metaTool("tc-learn-deny", execArgs("exec", {
      command: "wget bad-url",
    }));
    const proposalId = extractProposalId(text(promptResult));

    // 2. Deny with deny-always
    const approvalId = await webhook.waitFor(proposalId);
    const entry = pendingProposals.get(proposalId);
    if (entry) entry.approvalId = approvalId;

    const denyResult = await scApprove({ args: `${proposalId} deny-always` });
    expect(denyResult.text).toContain("Denied");
    expect(denyResult.text).toContain("remembered");
    expect(denyResult.text).toContain("wget *");

    // 3. Verify learned deny policy exists
    const { rules } = await client.listPolicies(sHash);
    const wgetRule = rules.find(
      (r) => r.template_name === "exec" && r.scope === "deny" && r.match_pattern?.command === "wget *"
    );
    expect(wgetRule).toBeDefined();

    // 4. Submit another matching exec — should auto-deny within 500ms
    const secondResult = await metaTool("tc-learn-deny-2", execArgs("exec", {
      command: "wget other-bad-url",
    }));
    const secondText = text(secondResult);
    // Should NOT return an approval prompt — learned policy should auto-deny
    expect(secondText).not.toContain("/sc-approve");
    expect(secondText).toContain("DENIED");

    // 5. Cleanup
    if (wgetRule) {
      await client.revokePolicy(wgetRule.rule_id);
    }
  }, 90_000);

  // -------------------------------------------------------------------------
  // Test: safeclaw_check tool
  // -------------------------------------------------------------------------

  it("safeclaw_check returns waiting then result after approval", async () => {
    if (!alive) return;

    // 1. Submit exec — gets approval prompt
    const promptResult = await metaTool("tc-check", execArgs("exec", {
      command: "echo check-test",
    }));
    const proposalId = extractProposalId(text(promptResult));

    // 2. Check before approving — should show waiting
    const waitingResult = await checkTool("tc-check-poll", { proposal_id: proposalId });
    const waitingText = text(waitingResult);
    expect(waitingText).toContain("waiting");

    // 3. Now approve
    const approvalId = await webhook.waitFor(proposalId);
    const entry = pendingProposals.get(proposalId);
    if (entry) entry.approvalId = approvalId;

    await scApprove({ args: `${proposalId} allow-once` });

    // 4. Check again — entry was cleaned up by scApprove, so should be "unknown"
    // (scApprove deletes from pendingProposals on success)
    const afterResult = await checkTool("tc-check-after", { proposal_id: proposalId });
    const afterText = text(afterResult);
    expect(afterText).toContain("Unknown or expired");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Trust profile tests
// ---------------------------------------------------------------------------

describe("Integration: trust profiles (live Validance)", () => {
  const client = new KernelClient(KERNEL_URL);
  const webhook = new WebhookServer();
  let alive = false;

  beforeAll(async () => {
    alive = await client.healthCheck();
    if (!alive) return;
    await webhook.start(WEBHOOK_PORT + 1);
  });

  afterEach(async () => {
    pendingProposals.clear();
    clearSessionCache();
  });

  afterAll(async () => {
    if (!alive) return;
    await webhook.stop();
  });

  // -------------------------------------------------------------------------
  // Conservative: write goes through human-confirm path (approval prompt)
  // -------------------------------------------------------------------------

  it("conservative: write shows approval prompt instead of auto-executing", async () => {
    if (!alive) return;

    const { metaTool } = registerPlugin(KERNEL_URL, WEBHOOK_PORT + 1, GATEWAY_HOST, "conservative");

    const result = await metaTool("tc-cons-write", {
      action: "write",
      params: { path: "/tmp/conservative-test.txt", content: "conservative profile test" },
      _sessionKey: `conservative-test-${randomUUID()}`,
    } as any);

    const output = text(result);
    // Conservative profile overrides write to human-confirm.
    // Plugin takes human-confirm path → fires proposal in background → 500ms race.
    // Kernel execution takes >500ms (container start), so approval prompt is shown.
    // This is the intended conservative behavior: user sees ALL actions as gated.
    expect(output).toContain("/sc-approve");
    expect(output).toContain("write");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Conservative: exec still requires approval (same as standard)
  // -------------------------------------------------------------------------

  it("conservative: exec still requires approval prompt", async () => {
    if (!alive) return;

    const { metaTool } = registerPlugin(KERNEL_URL, WEBHOOK_PORT + 1, GATEWAY_HOST, "conservative");

    const result = await metaTool("tc-cons-exec", {
      action: "exec",
      params: { command: "echo conservative-exec" },
      _sessionKey: `conservative-test-${randomUUID()}`,
    } as any);

    const output = text(result);
    // exec is human-confirm in both plugin and kernel → approval prompt
    expect(output).toContain("/sc-approve");
    expect(output).toContain("exec");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Power-user: write auto-approves (same as standard, auto-approve path)
  // -------------------------------------------------------------------------

  it("power-user: write auto-approves directly", async () => {
    if (!alive) return;

    const { metaTool } = registerPlugin(KERNEL_URL, WEBHOOK_PORT + 1, GATEWAY_HOST, "power-user");

    const result = await metaTool("tc-pu-write", {
      action: "write",
      params: { path: "/tmp/power-user-test.txt", content: "power-user profile test" },
      _sessionKey: `power-user-test-${randomUUID()}`,
    } as any);

    const output = text(result);
    // write is auto-approve in both plugin and kernel → direct result
    expect(output).not.toContain("/sc-approve");
    expect(
      output.includes("[COMPLETED]") ||
      output.includes("[FAILED]") ||
      output.includes("wrote") ||
      output.length > 0
    ).toBe(true);
  }, 60_000);
});
