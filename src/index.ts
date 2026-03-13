/**
 * @validance/safeclaw — OpenClaw plugin entry point.
 *
 * Registers:
 *   - `safeclaw` meta-tool (routes all actions to Validance containers)
 *   - `/safeclaw/approval-notify` HTTP route (webhook from Validance)
 *   - `safeclaw.approval.resolve` gateway method (UI-driven approval)
 *   - Health check on gateway start
 */

import { KernelClient } from "./kernel-client.js";
import { Catalog } from "./catalog.js";
import { createSafeClawTool, type SafeClawConfig } from "./meta-tool.js";
import {
  createApprovalNotifyHandler,
  createApprovalResolver,
} from "./approval-handler.js";
import type { TrustProfile } from "./trust-profiles.js";

export default {
  id: "@validance/safeclaw",

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

    // 2. Approval webhook receiver
    api.registerHttpRoute?.({
      method: "POST",
      path: "/safeclaw/approval-notify",
      handler: createApprovalNotifyHandler(api),
    });

    // 3. Approval resolution gateway method
    api.registerGatewayMethod?.(
      "safeclaw.approval.resolve",
      createApprovalResolver(client),
    );

    // 4. Health check on gateway start
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

    // 5. Cleanup on gateway stop
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

// Re-export types for consumers
export type { SafeClawConfig } from "./meta-tool.js";
export type { TrustProfile } from "./trust-profiles.js";
export { KernelClient } from "./kernel-client.js";
export { Catalog } from "./catalog.js";
