/**
 * safeclaw meta-tool — the single tool registered with OpenClaw.
 *
 * The LLM calls `safeclaw({action, params})` instead of dangerous built-in
 * tools. Each call maps to POST /api/proposals on the Validance kernel.
 */

import { randomUUID } from "node:crypto";
import type { KernelClient, ProposalResult } from "./kernel-client.js";
import type { Catalog } from "./catalog.js";
import { sessionHash } from "./session-map.js";
import { pendingProposals, gcPending } from "./pending-store.js";

export interface SafeClawConfig {
  kernelUrl: string;
  trustProfile?: string;
  gatewayPort?: number;
  /** Host/IP for the approval webhook URL (seen from Validance container). Defaults to "localhost". */
  gatewayHost?: string;
}

/**
 * Format the proposal result for the LLM.
 */
export function formatResult(result: ProposalResult): string {
  if (result.status === "denied") {
    return `[DENIED] ${result.reason ?? "Action was denied"}`;
  }
  if (result.status === "rate_limited") {
    return `[RATE LIMITED] ${result.reason ?? "Rate limit exceeded"}`;
  }
  if (result.status === "failed") {
    const err = result.result?.error ?? "Unknown error";
    const output = result.result?.output ?? "";
    return `[FAILED] ${err}\n${output}`.trim();
  }

  // completed
  const r = result.result;
  if (!r) return "[COMPLETED] (no output)";

  const parts: string[] = [];
  if (r.output) parts.push(r.output);
  if (r.output_vars && Object.keys(r.output_vars).length > 0) {
    parts.push(`Output variables: ${JSON.stringify(r.output_vars)}`);
  }
  return parts.join("\n") || "[COMPLETED] (no output)";
}

/**
 * Create the safeclaw meta-tool for OpenClaw plugin registration.
 */
export function createSafeClawTool(
  client: KernelClient,
  catalog: Catalog,
  config: SafeClawConfig,
  workspacePath: string,
) {
  const description = catalog.buildDescription();
  const actionNames = catalog.actionNames();

  // Build per-action parameter schemas for structured LLM guidance.
  // Each entry pairs the action enum value with its parameter schema,
  // giving the LLM JSON Schema validation instead of just text.
  const actionSchemas = actionNames.map((name) => {
    const t = catalog.templates[name];
    const paramSchema = t.parameter_schema;
    const props =
      paramSchema && typeof paramSchema === "object"
        ? (paramSchema as any).properties ?? {}
        : {};
    const req: string[] =
      paramSchema && typeof paramSchema === "object"
        ? (paramSchema as any).required ?? []
        : [];

    // Exclude the "action" property from params (it's top-level)
    const { action: _a, ...paramProps } = props;
    const paramRequired = req.filter((r: string) => r !== "action");

    return {
      type: "object" as const,
      properties: {
        action: { type: "string" as const, const: name },
        params: {
          type: "object" as const,
          properties: paramProps,
          ...(paramRequired.length > 0
            ? { required: paramRequired }
            : {}),
        },
      },
      required: ["action", "params"],
    };
  });

  return {
    name: "safeclaw",
    description,
    parameters: {
      oneOf: actionSchemas,
    },
    execute: async (
      _toolCallId: string,
      args: { action: string; params: Record<string, unknown> },
      signal?: AbortSignal,
      _onUpdate?: (update: unknown) => void,
    ) => {
      const sHash = sessionHash(
        (args as any)._sessionKey ?? "default",
      );

      const gatewayPort = config.gatewayPort ?? 18789;
      const gatewayHost = config.gatewayHost ?? "localhost";

      // Check if this action requires human approval
      const template = catalog.templates[args.action];
      if (template?.approval_tier === "human-confirm") {
        gcPending();

        const proposalId = randomUUID();
        const notifyUrl = `http://${gatewayHost}:${gatewayPort}/safeclaw/approval-notify?proposalId=${proposalId}`;

        // Fire in background — NO abort signal, let it block in Validance
        const promise = client.submitProposal({
          action: args.action,
          parameters: args.params,
          session_hash: sHash,
          workspace_path: workspacePath,
          notify_url: notifyUrl,
        });
        promise.catch(() => {}); // Swallow unhandled rejection

        // Store BEFORE the race check — webhook may arrive during the 500ms wait
        pendingProposals.set(proposalId, {
          promise,
          approvalId: null,
          action: args.action,
          params: args.params,
          createdAt: Date.now(),
        });

        // Quick check — did the kernel auto-approve server-side?
        // (learned policy, ceiling override, or catalog mismatch)
        const raceResult = await Promise.race([
          promise.then((r) => ({ resolved: true as const, result: r })),
          new Promise<{ resolved: false }>((r) =>
            setTimeout(() => r({ resolved: false }), 500),
          ),
        ]);

        if (raceResult.resolved) {
          pendingProposals.delete(proposalId);
          return {
            content: [{ type: "text" as const, text: formatResult(raceResult.result) }],
          };
        }

        return {
          content: [{ type: "text" as const, text:
            `Action requires approval: **${args.action}**\n` +
            "```json\n" + JSON.stringify(args.params, null, 2) + "\n```\n" +
            `To approve: \`/sc-approve ${proposalId} allow-once\`\n` +
            `To always approve this pattern: \`/sc-approve ${proposalId} allow-always\`\n` +
            `To deny: \`/sc-approve ${proposalId} deny\``,
          }],
        };
      }

      // Auto-approve path — blocks normally with abort signal
      const notifyUrl = `http://${gatewayHost}:${gatewayPort}/safeclaw/approval-notify`;

      const result = await client.submitProposal(
        {
          action: args.action,
          parameters: args.params,
          session_hash: sHash,
          workspace_path: workspacePath,
          notify_url: notifyUrl,
        },
        signal,
      );

      return {
        content: [{ type: "text" as const, text: formatResult(result) }],
      };
    },
  };
}
