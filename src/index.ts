/**
 * @validance/safeclaw — OpenClaw plugin entry point.
 *
 * Registers:
 *   - `safeclaw` meta-tool (routes all actions to Validance containers)
 *   - `/safeclaw/approval-notify` HTTP route (webhook from Validance)
 *   - `safeclaw.approval.resolve` gateway method (UI-driven approval)
 *   - Health check on gateway start
 */

import { KernelClient, type ApprovalResolution, type LearnedRule } from "./kernel-client.js";
import { Catalog } from "./catalog.js";
import { createSafeClawTool, type SafeClawConfig, formatResult } from "./meta-tool.js";
import {
  createApprovalNotifyHandler,
  createApprovalResolver,
  createApprovalCheckTool,
} from "./approval-handler.js";
import { pendingProposals } from "./pending-store.js";
import { deriveMatchPattern } from "./match-patterns.js";
import type { TrustProfile } from "./trust-profiles.js";

export default {
  id: "safeclaw",

  register(api: any) {
    const config: SafeClawConfig = (api.pluginConfig ?? {}) as SafeClawConfig;
    const kernelUrl = config.kernelUrl ?? "http://localhost:7400";
    const trustProfile = (config.trustProfile ?? "standard") as TrustProfile;

    const client = new KernelClient(kernelUrl);
    const catalog = Catalog.load(trustProfile);
    const workspacePath: string =
      api.config?.agent?.workspace ?? process.cwd();

    // 1. Meta-tool — the single tool the LLM calls
    api.registerTool(createSafeClawTool(client, catalog, config, workspacePath));

    // 2. Check tool — polls pending proposal results after approval
    api.registerTool(createApprovalCheckTool());

    // 3. Approval webhook receiver
    api.registerHttpRoute?.({
      path: "/safeclaw/approval-notify",
      auth: "plugin",
      handler: createApprovalNotifyHandler(),
    });

    // 4. Approval resolution gateway method
    api.registerGatewayMethod?.(
      "safeclaw.approval.resolve",
      createApprovalResolver(client),
    );

    // 5. Deterministic approval command — bypasses the LLM entirely
    api.registerCommand?.({
      name: "sc-approve",
      description: "Approve or deny a pending safeclaw action. Usage: /sc-approve <proposalId> allow-once|allow-always|deny|deny-always",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx: { args?: string }) => {
        const parts = (ctx.args ?? "").trim().split(/\s+/);
        const proposalId = parts[0];
        const decision = parts[1];

        if (!proposalId || !decision) {
          return {
            text: "Usage: `/sc-approve <proposalId> allow-once|allow-always|deny|deny-always`",
          };
        }

        const entry = pendingProposals.get(proposalId);
        if (!entry) {
          return { text: "Unknown or expired proposal ID." };
        }

        if (!entry.approvalId) {
          // Webhook hasn't arrived yet — wait briefly
          await new Promise((r) => setTimeout(r, 3000));
          if (!entry.approvalId) {
            return {
              text: "Approval notification not yet received from Validance. Try again in a moment.",
            };
          }
        }

        const isApprove = decision.startsWith("allow");
        const remember = decision === "allow-always" || decision === "deny-always";

        const resolution: ApprovalResolution = {
          decision: isApprove ? "approved" : "denied",
          decided_by: "user",
          remember,
          ...(remember ? { match_pattern: deriveMatchPattern(entry.action, entry.params) } : {}),
        };

        try {
          await client.resolveApproval(entry.approvalId, resolution);
        } catch (err) {
          return { text: `Failed to resolve: ${err}` };
        }

        if (!isApprove) {
          pendingProposals.delete(proposalId);
          const scope = remember
            ? ` (remembered: ${JSON.stringify(resolution.match_pattern)})`
            : "";
          return { text: `Denied: **${entry.action}**${scope}` };
        }

        // Wait for execution result
        try {
          const result = await Promise.race([
            entry.promise,
            new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
          ]);

          pendingProposals.delete(proposalId);

          if (!result) {
            return { text: "Approved, but execution timed out. Use `safeclaw_check` tool to poll." };
          }

          return { text: `Approved & executed:\n${formatResult(result)}` };
        } catch (err) {
          pendingProposals.delete(proposalId);
          return { text: `Approved, but execution failed: ${err}` };
        }
      },
    });

    // 6. Policy management command
    api.registerCommand?.({
      name: "sc-policies",
      description: "List or revoke learned policy rules. Usage: /sc-policies [revoke <rule_id>]",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx: { args?: string }) => {
        const parts = (ctx.args ?? "").trim().split(/\s+/);
        const subcommand = parts[0];

        if (subcommand === "revoke") {
          const ruleId = parts[1];
          if (!ruleId) {
            return { text: "Usage: `/sc-policies revoke <rule_id>`" };
          }
          try {
            await client.revokePolicy(ruleId);
            return { text: `Rule \`${ruleId}\` revoked.` };
          } catch (err) {
            return { text: `Failed to revoke: ${err}` };
          }
        }

        // Default: list all rules
        try {
          const { rules } = await client.listPolicies();
          if (rules.length === 0) {
            return { text: "No learned policy rules." };
          }

          const header = "| ID | Action | Scope | Pattern | Age |\n|---|---|---|---|---|";
          const rows = rules.map((r) => {
            const age = formatAge(r.created_at);
            const pattern = Object.entries(r.match_pattern)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            return `| \`${r.rule_id.slice(0, 8)}\` | ${r.template_name} | ${r.scope} | ${pattern} | ${age} |`;
          });

          return { text: `**Learned policy rules** (${rules.length})\n\n${header}\n${rows.join("\n")}` };
        } catch (err) {
          return { text: `Failed to list policies: ${err}` };
        }
      },
    });

    // 7. Health check on gateway start
    api.on?.("gateway_start", async () => {
      const ok = await client.healthCheck();
      if (!ok) {
        (api.logger ?? console).error(
          `[safeclaw] Validance unreachable at ${kernelUrl}`,
        );
      } else {
        (api.logger ?? console).info(
          `[safeclaw] Connected to Validance at ${kernelUrl}`,
        );
      }
    });

    // 8. Cleanup on gateway stop
    api.on?.("gateway_stop", async () => {
      try {
        // Try to cleanup session containers — best effort
        await client.cleanupSession("all");
      } catch {
        // Kernel may already be down
      }
    });
  },
};

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Re-export types for consumers
export type { SafeClawConfig } from "./meta-tool.js";
export type { TrustProfile } from "./trust-profiles.js";
export { KernelClient } from "./kernel-client.js";
export { Catalog } from "./catalog.js";
