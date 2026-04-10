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
import { pendingProposals, addPending } from "./pending-store.js";
import { STANDARD_SAFE_EXEC } from "./trust-profiles.js";

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
 * Resolve the effective approval tier for an action, accounting for
 * safe-exec overrides in non-conservative profiles.
 *
 * In `standard` and `power-user` profiles, exec commands whose first token
 * is in STANDARD_SAFE_EXEC are downgraded from `human-confirm` to
 * `auto-approve` — no approval gate needed for `ls`, `cat`, `grep`, etc.
 */
export function effectiveApprovalTier(
  action: string,
  params: Record<string, unknown>,
  catalogTier: string | undefined,
  trustProfile: string,
): string | undefined {
  if (
    catalogTier === "human-confirm" &&
    action === "exec" &&
    trustProfile !== "conservative"
  ) {
    const firstToken = String(params.command ?? "").trim().split(/\s+/)[0];
    if (firstToken && STANDARD_SAFE_EXEC.has(firstToken)) {
      return "auto-approve";
    }
  }
  return catalogTier;
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

  // Build a flat parameter schema — no oneOf/anyOf/allOf.
  // OpenClaw (Anthropic API) rejects top-level oneOf and the normalizer
  // merges variants incorrectly, causing the LLM to wrap params in
  // {"input": "<json string>"} instead of passing them flat.
  // Instead: single object with action enum + merged params properties.
  const allParamProps: Record<string, unknown> = {};
  for (const name of actionNames) {
    const t = catalog.templates[name];
    const paramSchema = t.parameter_schema;
    const props =
      paramSchema && typeof paramSchema === "object"
        ? (paramSchema as any).properties ?? {}
        : {};
    const { action: _a, ...paramProps } = props;
    for (const [key, value] of Object.entries(paramProps)) {
      if (!(key in allParamProps)) {
        allParamProps[key] = value;
      }
    }
  }

  return {
    name: "safeclaw",
    description,
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: actionNames,
          description: "The action to perform",
        },
        params: {
          type: "object" as const,
          properties: allParamProps,
          description: "Action-specific parameters. See the tool description for each action's required parameters.",
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
        (args as any)._agentId ?? (args as any)._sessionKey ?? "default",
      );

      const gatewayPort = config.gatewayPort ?? 18789;
      const gatewayHost = config.gatewayHost ?? "localhost";

      // Check if this action requires human approval
      const template = catalog.templates[args.action];
      const tier = effectiveApprovalTier(
        args.action, args.params, template?.approval_tier,
        config.trustProfile ?? "standard",
      );
      if (tier === "human-confirm") {
        const proposalId = randomUUID();
        const notifyUrl = `http://${gatewayHost}:${gatewayPort}/safeclaw/approval-notify?proposalId=${proposalId}`;

        // Extract input_files and session_hash from params — promoted to top-level fields on kernel request.
        // session_hash override lets callers link proposals to a specific session (e.g. pipeline session).
        const { input_files, session_hash: sessionOverride, ...cleanParams } = args.params;

        // Fire in background — NO abort signal, let it block in Validance
        const promise = client.submitProposal({
          action: args.action,
          parameters: cleanParams,
          session_hash: typeof sessionOverride === "string" ? sessionOverride : sHash,
          mounts: [{ host_path: workspacePath, container_path: "/workspace", mode: "rw" }],
          notify_url: notifyUrl,
          ...(input_files ? { input_files: input_files as Record<string, string> } : {}),
          caller_id: "safeclaw",
        });
        promise.catch(() => {}); // Swallow unhandled rejection

        // Store BEFORE the race check — webhook may arrive during the 500ms wait
        addPending(proposalId, {
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

      // Auto-approve path — blocks normally with abort signal.
      // Pass approval_tier_override so the kernel skips its own gate when the
      // catalog marks the action human-confirm but the caller's trust policy
      // allows it (e.g. safe exec commands in standard profile).
      // Extract input_files and session_hash from params — promoted to top-level fields on kernel request
      const { input_files: autoInputFiles, session_hash: autoSessionOverride, ...autoCleanParams } = args.params;
      const result = await client.submitProposal(
        {
          action: args.action,
          parameters: autoCleanParams,
          session_hash: typeof autoSessionOverride === "string" ? autoSessionOverride : sHash,
          mounts: [{ host_path: workspacePath, container_path: "/workspace", mode: "rw" }],
          approval_tier_override: "auto-approve",
          ...(autoInputFiles ? { input_files: autoInputFiles as Record<string, string> } : {}),
          caller_id: "safeclaw",
        },
        signal,
      );

      return {
        content: [{ type: "text" as const, text: formatResult(result) }],
      };
    },
  };
}
