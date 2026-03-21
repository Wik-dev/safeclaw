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

/** Maximum number of pending entries before oldest-eviction kicks in. */
export const MAX_PENDING = 100;

/** Garbage-collect entries older than 10 minutes. */
export function gcPending(): void {
  const cutoff = Date.now() - 600_000;
  for (const [id, entry] of pendingProposals) {
    if (entry.createdAt < cutoff) pendingProposals.delete(id);
  }
}

/**
 * Add a pending entry with bounded-size enforcement.
 *
 * 1. Runs GC to reclaim expired entries.
 * 2. If still at capacity, evicts the oldest entry (lowest createdAt).
 * 3. Inserts the new entry.
 */
export function addPending(id: string, entry: PendingEntry): void {
  gcPending();
  if (pendingProposals.size >= MAX_PENDING) {
    let oldestId: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of pendingProposals) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestId = k;
      }
    }
    if (oldestId !== undefined) pendingProposals.delete(oldestId);
  }
  pendingProposals.set(id, entry);
}
