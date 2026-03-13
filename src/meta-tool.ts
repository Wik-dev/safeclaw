/**
 * safeclaw meta-tool — the single tool registered with OpenClaw.
 *
 * The LLM calls `safeclaw({action, params})` instead of dangerous built-in
 * tools. Each call maps to POST /api/proposals on the Validance kernel.
 */

import type { KernelClient, ProposalResult } from "./kernel-client.js";
import type { Catalog } from "./catalog.js";
import { sessionHash } from "./session-map.js";

export interface SafeClawConfig {
  kernelUrl: string;
  trustProfile?: string;
  gatewayPort?: number;
}

/**
 * Format the proposal result for the LLM.
 */
function formatResult(result: ProposalResult): string {
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

  return {
    name: "safeclaw",
    description,
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: actionNames,
          description: "The action to execute in a container",
        },
        params: {
          type: "object" as const,
          description: "Action-specific parameters",
        },
      },
      required: ["action", "params"],
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
      const notifyUrl = `http://localhost:${gatewayPort}/safeclaw/approval-notify`;

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
