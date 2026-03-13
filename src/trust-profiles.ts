/**
 * Trust profile type definitions and defaults.
 *
 * Trust profiles override approval tiers per template:
 * - **conservative**: everything human-confirm, gateway always-deny
 * - **standard**: exec/browser/message/cron human-confirm, file/web auto-approve
 * - **power-user**: exec/browser auto-approve, everything else same as standard
 */

export type TrustProfile = "conservative" | "standard" | "power-user";

export const DEFAULT_TRUST_PROFILE: TrustProfile = "standard";

/**
 * Tools that should stay local (NOT denied in `tools.deny`).
 * These are read-only or session-management tools.
 */
export const LOCAL_TOOLS = [
  "read",
  "sessions_list",
  "sessions_history",
  "session_status",
  "agents_list",
  "subagents",
  "sessions_spawn",
] as const;

/**
 * Tools that should be denied in `tools.deny` config.
 * These are routed through safeClaw instead.
 */
export const DENIED_TOOLS = [
  "exec",
  "bash",
  "write",
  "edit",
  "apply_patch",
  "message",
  "sessions_send",
  "browser",
  "web_search",
  "web_fetch",
  "cron",
  "canvas",
  "nodes",
  "gateway",
  "image",
  "tts",
] as const;
