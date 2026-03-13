/**
 * Session key → session_hash mapping.
 *
 * OpenClaw session keys are opaque strings. Validance needs stable
 * SHA-256 hashes for rate limiting, budgets, and persistent worker keying.
 */

import { createHash } from "node:crypto";

const cache = new Map<string, string>();

/**
 * Derive a stable session_hash from an OpenClaw session key.
 *
 * Uses SHA-256 with a fixed prefix to avoid collisions with other
 * hash uses. Results are cached for the process lifetime.
 */
export function sessionHash(sessionKey: string): string {
  let hash = cache.get(sessionKey);
  if (!hash) {
    hash = createHash("sha256")
      .update(`safeclaw:${sessionKey}`)
      .digest("hex");
    cache.set(sessionKey, hash);
  }
  return hash;
}

/**
 * Clear the session cache (for testing).
 */
export function clearSessionCache(): void {
  cache.clear();
}
