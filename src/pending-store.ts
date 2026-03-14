/**
 * In-memory store linking agent-side proposalId to Validance-side approvalId.
 *
 * When meta-tool fires a human-confirm proposal in the background, it stores
 * the Promise here keyed by a local UUID. The webhook handler later links the
 * Validance approval_id, and the resolver / check tool await the Promise.
 *
 * Uses globalThis to guarantee a single Map instance even if this module
 * is loaded multiple times (different resolution paths in the plugin loader).
 */

import type { ProposalResult } from "./kernel-client.js";

export interface PendingEntry {
  promise: Promise<ProposalResult>;
  approvalId: string | null;
  action: string;
  params: Record<string, unknown>;
  createdAt: number;
}

const GLOBAL_KEY = "__safeclaw_pendingProposals__";

export const pendingProposals: Map<string, PendingEntry> =
  (globalThis as any)[GLOBAL_KEY] ??= new Map<string, PendingEntry>();

/** Garbage-collect entries older than 10 minutes. */
export function gcPending(): void {
  const cutoff = Date.now() - 600_000;
  for (const [id, entry] of pendingProposals) {
    if (entry.createdAt < cutoff) pendingProposals.delete(id);
  }
}
