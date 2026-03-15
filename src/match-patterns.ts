/**
 * Derive sensible match_pattern from a template action + parameters.
 *
 * When a user chooses "allow-always" or "deny-always", the kernel stores
 * a learned rule with a ``match_pattern``. If the caller sends ``{}``,
 * the kernel treats it as "match everything for this template" — which
 * is dangerously broad (e.g., allow-always on ``exec`` with ``git status``
 * would auto-approve ``rm -rf /``).
 *
 * This module generates scoped patterns per template so learned rules
 * are specific enough to be safe yet general enough to be useful.
 */

/**
 * Extract the first token (command name / binary) from a shell command.
 * Returns the token followed by ` *` for glob matching.
 *
 * Examples:
 *   "git status"       → "git *"
 *   "npm run build"    → "npm *"
 *   "ls"               → "ls"
 *   ""                 → "*"
 */
function commandPrefix(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "*";
  const firstToken = trimmed.split(/\s+/)[0];
  // Single-word command with no arguments → exact match (no wildcard)
  if (!trimmed.includes(" ")) return firstToken;
  return `${firstToken} *`;
}

/**
 * Extract the directory prefix from a file path.
 * Returns the directory followed by `/*` for glob matching.
 *
 * Examples:
 *   "src/index.ts"          → "src/*"
 *   "docs/api/README.md"    → "docs/api/*"
 *   "file.txt"              → "*"
 */
function directoryPrefix(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return "*";
  return filePath.slice(0, lastSlash) + "/*";
}

/**
 * Extract the origin from a URL.
 * Returns `origin/*` for glob matching.
 *
 * Examples:
 *   "https://api.x.com/data"       → "https://api.x.com/*"
 *   "http://localhost:3000/path"    → "http://localhost:3000/*"
 *   "not-a-url"                     → "*"
 */
function urlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/*`;
  } catch {
    return "*";
  }
}

/**
 * Derive a match_pattern for a learned policy rule.
 *
 * The pattern should be specific enough to prevent dangerously broad
 * auto-approve/deny, but general enough that the "always" decision
 * covers similar future invocations of the same kind.
 *
 * @param action   - Template name (e.g. "exec", "browser", "write")
 * @param params   - The proposal parameters that triggered approval
 * @returns          Glob-style match pattern for the kernel's fnmatch
 */
export function deriveMatchPattern(
  action: string,
  params: Record<string, unknown>,
): Record<string, string> {
  switch (action) {
    case "exec":
      return { command: commandPrefix(String(params.command ?? "")) };

    case "browser":
      return params.action ? { action: String(params.action) } : {};

    case "message": {
      const pat: Record<string, string> = {};
      if (params.channel) pat.channel = String(params.channel);
      if (params.target) pat.target = String(params.target);
      return Object.keys(pat).length > 0 ? pat : {};
    }

    case "cron":
    case "canvas":
    case "nodes":
    case "process":
      return params.action ? { action: String(params.action) } : {};

    case "write":
    case "edit":
    case "apply_patch":
      return { path: directoryPrefix(String(params.path ?? "")) };

    case "web_fetch":
      return { url: urlOrigin(String(params.url ?? "")) };

    case "sessions_send":
      return params.session_key
        ? { session_key: String(params.session_key) }
        : {};

    default:
      return {};
  }
}
