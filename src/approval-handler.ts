/**
 * Approval webhook handler + resolver + check tool.
 *
 * Webhook: correlates Validance approval_id with agent-side proposalId
 * via the ?proposalId= query parameter on notify_url.
 *
 * Resolver: looks up proposalId → approvalId, resolves via kernel,
 * optionally waits for execution result.
 *
 * Check tool: polls background promise for a pending proposal.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { KernelClient, ApprovalResolution, ProposalResult } from "./kernel-client.js";
import { pendingProposals, gcPending } from "./pending-store.js";
import { formatResult } from "./meta-tool.js";

export interface ApprovalNotification {
  type: "approval_required";
  approval_id: string;
  template_name: string;
  proposal: Record<string, unknown>;
}

/** Read raw request body as string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Extract query parameter from a URL path string. */
export function getQueryParam(url: string | undefined, key: string): string | null {
  if (!url) return null;
  const idx = url.indexOf("?");
  if (idx === -1) return null;
  const params = new URLSearchParams(url.slice(idx));
  return params.get(key);
}

/**
 * Create the webhook HTTP handler for approval notifications.
 *
 * When Validance creates an approval record, it POSTs to the notify_url
 * which includes ?proposalId=<uuid>. This handler links the Validance
 * approval_id to the agent-side proposalId in the pending store.
 */
export function createApprovalNotifyHandler() {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const raw = await readBody(req);
      const body: ApprovalNotification = JSON.parse(raw);
      const { approval_id } = body;

      // Extract proposalId from ?proposalId= query param
      const proposalId = getQueryParam(req.url, "proposalId");
      // Log for debugging (no file I/O in production)
      console.log(`[safeclaw] Webhook: approval_id=${approval_id}, proposalId=${proposalId ?? "none"}, pendingCount=${pendingProposals.size}`);
      if (proposalId) {
        const entry = pendingProposals.get(proposalId);
        if (entry) {
          entry.approvalId = approval_id;
          console.log(`[safeclaw] Linked approval ${approval_id} to proposal ${proposalId}`);
        } else {
          console.log(`[safeclaw] No pending entry for proposalId=${proposalId}`);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    } catch (err) {
      console.error("[safeclaw] Approval notify handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  };
}

/**
 * Create the gateway method handler for resolving approvals.
 *
 * Accepts either a Validance approval_id directly, or a proposalId
 * (agent-side UUID) which is looked up in the pending store.
 */
export function createApprovalResolver(client: KernelClient) {
  return async (params: {
    approval_id?: string;
    proposal_id?: string;
    decision: "approved" | "denied";
    remember?: boolean;
    match_pattern?: Record<string, string>;
    reason?: string;
  }) => {
    // Resolve the Validance approval_id
    let approvalId = params.approval_id;
    const entry = params.proposal_id
      ? pendingProposals.get(params.proposal_id)
      : undefined;

    if (!approvalId && entry?.approvalId) {
      approvalId = entry.approvalId;
    }

    if (!approvalId) {
      return { error: "No approval_id available — webhook may not have arrived yet" };
    }

    const resolution: ApprovalResolution = {
      decision: params.decision,
      reason: params.reason,
      decided_by: "user",
      remember: params.remember,
      match_pattern: params.match_pattern,
    };

    const resolveResult = await client.resolveApproval(approvalId, resolution);

    // If we have the background promise, wait for execution result
    if (entry) {
      try {
        const result = await Promise.race([
          entry.promise,
          new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
        ]);
        if (result) {
          return { ...resolveResult, execution_result: result };
        }
      } catch {
        // Execution may have failed — that's fine, return resolve result
      }
    }

    return resolveResult;
  };
}

/** Wait for a promise with a timeout, returning null on timeout. */
export function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

/**
 * Create the safeclaw_check tool for polling pending proposal results.
 *
 * The agent calls this after approval to retrieve the execution output.
 */
export function createApprovalCheckTool() {
  return {
    name: "safeclaw_check",
    description:
      "Check the result of a pending safeclaw action that required approval. " +
      "Pass the proposal_id returned by the safeclaw tool.",
    parameters: {
      type: "object" as const,
      properties: {
        proposal_id: {
          type: "string" as const,
          description: "The proposal ID from the approval prompt",
        },
      },
      required: ["proposal_id"],
    },
    execute: async (
      _toolCallId: string,
      args: { proposal_id: string },
    ) => {
      gcPending();

      const entry = pendingProposals.get(args.proposal_id);
      if (!entry) {
        return {
          content: [{ type: "text" as const, text:
            "Unknown or expired proposal ID. Proposals expire after 10 minutes.",
          }],
        };
      }

      let result: ProposalResult | null;
      try {
        result = await raceTimeout(entry.promise, 15_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `[ERROR] ${msg}` }],
        };
      }

      if (!result) {
        return {
          content: [{ type: "text" as const, text:
            "Still waiting for result. The action may not have been approved yet.\n" +
            `To approve: \`/sc-approve ${args.proposal_id} allow-once\`\n` +
            `To deny: \`/sc-approve ${args.proposal_id} deny\``,
          }],
        };
      }

      // Clean up completed entry
      pendingProposals.delete(args.proposal_id);

      return {
        content: [{ type: "text" as const, text: formatResult(result) }],
      };
    },
  };
}
