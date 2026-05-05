/**
 * Local catalog for tool descriptions and trust profiles.
 *
 * Loads `catalog/default.json` and applies trust profile overrides.
 * Optionally merges a deployment-specific overlay (ADR-002).
 * Generates the meta-tool description from template parameter schemas.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface TemplateEntry {
  description?: string;
  action_hints?: Record<string, string>;
  persistent?: boolean;
  docker_image?: string;
  command_template?: string;
  parameter_schema?: Record<string, unknown>;
  approval_tier: string;
  /**
   * Per-entry trust-profile tier overrides (ADR-002 § 3.3).
   * Keyed by profile name; value replaces `approval_tier` under that profile.
   * Lets overlay entries declare their own profile semantics without
   * editing the shared blanket-rule table.
   */
  tier_overrides?: Partial<Record<TrustProfile, string>>;
  timeout?: number;
  rate_limit?: number;
  secret_refs?: string[];
  volumes?: Record<string, unknown>;
  policy_ceilings?: string[];
  network_policy?: Record<string, unknown> | null;
}

export interface CatalogData {
  templates: Record<string, TemplateEntry>;
  images: Record<string, string>;
}

export type TrustProfile = "conservative" | "standard" | "power-user";

/**
 * Blanket trust-profile rules — apply to every OpenClaw-native template
 * regardless of action name. Per-entry refinements live in
 * `TemplateEntry.tier_overrides` (ADR-002 § 3.3).
 *
 * `conservative` promotes everything that's not already always-deny up
 * to human-confirm. `power-user` relaxes the historically-confirm-only
 * native actions to auto-approve.
 */
const TRUST_OVERRIDES: Record<TrustProfile, Record<string, string>> = {
  conservative: {
    exec: "human-confirm",
    write: "human-confirm",
    edit: "human-confirm",
    browser: "human-confirm",
    web_search: "human-confirm",
    web_fetch: "human-confirm",
    message: "human-confirm",
    sessions_send: "human-confirm",
    cron: "human-confirm",
    process: "human-confirm",
    image: "human-confirm",
    tts: "human-confirm",
    canvas: "human-confirm",
    nodes: "human-confirm",
    gateway: "always-deny",
  },
  standard: {
    // default.json already has standard tiers
  },
  "power-user": {
    exec: "auto-approve",
    browser: "auto-approve",
  },
};

export class Catalog {
  readonly templates: Record<string, TemplateEntry>;
  readonly images: Record<string, string>;

  constructor(data: CatalogData, profile: TrustProfile = "standard") {
    this.images = { ...data.images };
    this.templates = {};

    const blanket = TRUST_OVERRIDES[profile] ?? {};
    for (const [name, entry] of Object.entries(data.templates)) {
      // Resolve effective tier: per-entry override (most specific) wins
      // over blanket profile rule, which wins over the entry's own
      // `approval_tier` (least specific).
      const perEntry = entry.tier_overrides?.[profile];
      const effective = perEntry ?? blanket[name] ?? entry.approval_tier;
      this.templates[name] = {
        ...entry,
        approval_tier: effective,
      };
    }
  }

  /**
   * Load catalog from the bundled `catalog/default.json`, optionally
   * merging a deployment-specific overlay file (ADR-002 § 3.2).
   *
   * Overlay templates are merged into defaults; on key collision the
   * overlay wins (operators can override default entries by re-declaring
   * them). Same merge applies to the `images` map.
   *
   * Failure modes:
   *   - overlay path supplied but file missing → throws (operator
   *     misconfiguration, fail loud at registration time)
   *   - overlay path not supplied → load defaults only
   *   - malformed JSON in either file → throws
   *
   * @param profile  Trust profile applied after merge.
   * @param overlayPath  Optional absolute path to overlay JSON.
   */
  static load(
    profile: TrustProfile = "standard",
    overlayPath?: string,
  ): Catalog {
    const defaultPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "catalog",
      "default.json",
    );
    const data: CatalogData = JSON.parse(readFileSync(defaultPath, "utf-8"));

    if (overlayPath) {
      const overlay: CatalogData = JSON.parse(
        readFileSync(overlayPath, "utf-8"),
      );
      Object.assign(data.templates, overlay.templates ?? {});
      Object.assign(data.images, overlay.images ?? {});
    }

    return new Catalog(data, profile);
  }

  /**
   * Get sorted list of action names (excluding always-deny).
   */
  actionNames(): string[] {
    return Object.entries(this.templates)
      .filter(([, t]) => t.approval_tier !== "always-deny")
      .map(([name]) => name)
      .sort();
  }

  /**
   * Build a description string for the meta-tool.
   *
   * Generates per-action documentation from parameter schemas so the LLM
   * knows exactly which actions are available and what parameters each takes.
   * Uses catalog `description` for tool summaries, `action_hints` for
   * semantic action grouping, and shows array item types.
   */
  buildDescription(): string {
    const lines = [
      "Execute actions in isolated containers via safeClaw.",
      "Each action runs in a Docker container — the host is never touched.",
      'Pass {action, params} where params contains the action-specific parameters below.',
    ];

    for (const name of this.actionNames()) {
      const t = this.templates[name];
      const tier = t.approval_tier;
      const tierNote =
        tier === "human-confirm" ? " [requires approval]" : "";
      lines.push("", `## ${name}${tierNote}`);

      // Tool summary from catalog description
      if (t.description) {
        lines.push(t.description);
      }

      const schema = t.parameter_schema;
      if (!schema || typeof schema !== "object") continue;

      const props = (schema as any).properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const required: string[] = (schema as any).required ?? [];
      if (!props) continue;

      // Action grouping from action_hints
      const hasHints = t.action_hints && Object.keys(t.action_hints).length > 0;
      if (hasHints) {
        lines.push("Actions:");
        for (const [category, actions] of Object.entries(t.action_hints!)) {
          lines.push(`  ${category}: ${actions}`);
        }
      }

      for (const [pName, spec] of Object.entries(props)) {
        const req = required.includes(pName) ? " (required)" : "";
        const desc = (spec.description as string) ?? "";
        const enumVals = spec.enum as string[] | undefined;

        // Skip enum values on action param when action_hints are shown
        if (pName === "action" && hasHints && enumVals) {
          let line = `- ${pName}${req}`;
          if (desc) line += `: ${desc}`;
          lines.push(line);
          continue;
        }

        let line = `- ${pName}${req}`;
        if (enumVals) {
          line += `: ${enumVals.join(" | ")}`;
          if (desc) line += ` — ${desc}`;
        } else if (desc) {
          line += `: ${desc}`;
        } else {
          const type = (spec.type as string) ?? "any";
          // Array type hint: show items type
          if (type === "array") {
            const itemsType = (spec.items as Record<string, unknown> | undefined)?.type as string | undefined;
            line += itemsType ? ` (array of ${itemsType})` : " (array)";
          } else {
            line += ` (${type})`;
          }
        }
        lines.push(line);
      }
    }

    return lines.join("\n");
  }
}
