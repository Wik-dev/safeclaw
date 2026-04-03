/**
 * HTTP client for Validance kernel — zero external dependencies.
 *
 * Uses native `fetch` (Node 18+). All calls go to the kernel's REST API.
 */

export interface ProposalRequest {
  action: string;
  parameters: Record<string, unknown>;
  session_hash: string;
  mounts?: Array<{ host_path: string; container_path: string; mode: "ro" | "rw" }>;
  notify_url?: string;
  /** Override the kernel catalog's approval tier. Only "auto-approve" is accepted
   *  (callers may not escalate to always-deny). Use when the caller's trust policy
   *  permits auto-approval for an action the kernel catalog marks human-confirm. */
  approval_tier_override?: "auto-approve";
}

export interface ProposalResult {
  status: "completed" | "failed" | "denied" | "rate_limited";
  result?: {
    output: string;
    output_vars: Record<string, unknown>;
    exit_code?: number;
    error?: string;
  };
  reason?: string;
  resource_usage?: Record<string, unknown>;
  duration_seconds?: number;
}

export interface ApprovalResolution {
  decision: "approved" | "denied";
  reason?: string;
  decided_by?: string;
  remember?: boolean;
  match_pattern?: Record<string, string>;
}

export interface LearnedRule {
  rule_id: string;
  template_name: string;
  match_pattern: Record<string, string>;
  scope: "allow" | "deny";
  created_from: string;
  session_hash?: string;
  expires_at?: string;
  created_at: string;
}

export class KernelClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(kernelUrl: string, timeoutMs = 300_000) {
    // Strip trailing slash
    this.baseUrl = kernelUrl.replace(/\/+$/, "");
    this.timeout = timeoutMs;
  }

  /**
   * Submit a tool proposal — blocks until approved + executed.
   */
  async submitProposal(
    request: ProposalRequest,
    signal?: AbortSignal,
  ): Promise<ProposalResult> {
    const res = await this.post("/api/proposals", request, signal);
    return res as unknown as ProposalResult;
  }

  /**
   * Resolve a pending approval.
   */
  async resolveApproval(
    approvalId: string,
    resolution: ApprovalResolution,
  ): Promise<Record<string, unknown>> {
    return this.post(`/api/approvals/${approvalId}/resolve`, resolution);
  }

  /**
   * List learned policy rules.
   */
  async listPolicies(
    sessionHash?: string,
  ): Promise<{ rules: LearnedRule[] }> {
    const qs = sessionHash ? `?session_hash=${sessionHash}` : "";
    return this.get(`/api/policies${qs}`);
  }

  /**
   * Revoke a learned policy rule.
   */
  async revokePolicy(ruleId: string): Promise<Record<string, unknown>> {
    return this.del(`/api/policies/${ruleId}`);
  }

  /**
   * Cleanup session containers.
   */
  async cleanupSession(sessionHash: string): Promise<Record<string, unknown>> {
    return this.del(`/api/sessions/${sessionHash}`);
  }

  /**
   * Health check — returns true if kernel is reachable and healthy.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // -- internal helpers --

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    // Compose signals: caller's signal + our timeout
    const abortHandler = () => controller.abort();
    signal?.addEventListener("abort", abortHandler);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok && res.status !== 429) {
        const text = await res.text().catch(() => "");
        throw new Error(`Kernel ${path} failed (${res.status}): ${text}`);
      }

      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
    }
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kernel GET ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  private async del(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kernel DELETE ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }
}
