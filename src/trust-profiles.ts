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
  "process",
  "canvas",
  "nodes",
  "gateway",
  "image",
  "tts",
] as const;

/**
 * Exec command binaries that auto-approve in `standard` and `power-user` profiles.
 * Matched against the first whitespace-delimited token of the command string.
 * These are read-only inspection tools with no persistent side effects.
 * Ignored in `conservative` profile (everything stays human-confirm).
 */
export const STANDARD_SAFE_EXEC: ReadonlySet<string> = new Set([
  // filesystem inspection
  "ls", "ll", "la", "pwd", "cat", "head", "tail", "wc",
  "find", "file", "stat", "du", "df", "tree", "less", "more",
  // text processing (read-only)
  "grep", "egrep", "fgrep", "rg", "awk", "sed", "sort", "uniq",
  "diff", "comm", "cut", "tr", "fold", "nl", "od", "xxd",
  // output / no-ops
  "echo", "printf", "true", "false",
  // process / system info
  "ps", "pgrep", "free", "uptime", "date", "uname",
  "whoami", "id", "groups", "env", "printenv",
  // command discovery
  "which", "whereis", "type",
  // misc read-only
  "basename", "dirname", "realpath", "readlink",
]);
