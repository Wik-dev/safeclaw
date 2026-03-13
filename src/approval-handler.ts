/**
 * Approval webhook handler + gateway broadcast.
 *
 * Receives POST from Validance when a approval record is created,
 * surfaces it to the user via the gateway's broadcast mechanism.
 */

import type { KernelClient, ApprovalResolution } from "./kernel-client.js";

export interface ApprovalNotification {
  type: "approval_required";
  approval_id: string;
  template_name: string;
  proposal: Record<string, unknown>;
}

/**
 * Format a human-readable approval prompt.
 */
function formatApprovalPrompt(
  templateName: string,
  proposal: Record<string, unknown>,
): string {
  const params = proposal.parameters ?? proposal;
  const paramsStr = JSON.stringify(params, null, 2);
  return [
    `Action requires approval: **${templateName}**`,
    "```json",
    paramsStr,
    "```",
    "Reply: approve / approve & remember / deny / deny & remember",
  ].join("\n");
}

/**
 * Create the webhook HTTP handler for approval notifications.
 *
 * This handler is registered as an HTTP route on the OpenClaw gateway.
 * When Validance creates a approval record with a notify_url, it POSTs
 * to this endpoint, which broadcasts the approval request to connected
 * clients.
 */
export function createApprovalNotifyHandler(api: any) {
  return async (req: any, res: any) => {
    try {
      const body: ApprovalNotification = req.body;
      const { approval_id, template_name, proposal } = body;

      // Surface to user via gateway broadcast
      api.runtime?.broadcast?.("safeclaw:approval", {
        approval_id,
        template_name,
        proposal,
        message: formatApprovalPrompt(template_name, proposal),
      });

      res.json({ received: true });
    } catch (err) {
      console.error("[safeclaw] Approval notify handler error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  };
}

/**
 * Create the gateway method handler for resolving approvals.
 *
 * Registered as `safeclaw.approval.resolve` — called from the control UI
 * or chat commands.
 */
export function createApprovalResolver(client: KernelClient) {
  return async (params: {
    approval_id: string;
    decision: "approved" | "denied";
    remember?: boolean;
    match_pattern?: Record<string, string>;
    reason?: string;
  }) => {
    const resolution: ApprovalResolution = {
      decision: params.decision,
      reason: params.reason,
      decided_by: "user",
      remember: params.remember,
      match_pattern: params.match_pattern,
    };
    return client.resolveApproval(params.approval_id, resolution);
  };
}
