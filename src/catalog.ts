/**
 * Local catalog for tool descriptions and trust profiles.
 *
 * Loads `catalog/default.json` and applies trust profile overrides.
 * Generates the meta-tool description from template parameter schemas.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface TemplateEntry {
  persistent?: boolean;
  docker_image?: string;
  command_template?: string;
  parameter_schema?: Record<string, unknown>;
  approval_tier: string;
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
 * Trust profile tier overrides.
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

    // Deep copy and apply profile overrides
    const overrides = TRUST_OVERRIDES[profile] ?? {};
    for (const [name, entry] of Object.entries(data.templates)) {
      this.templates[name] = {
        ...entry,
        approval_tier: overrides[name] ?? entry.approval_tier,
      };
    }
  }

  /**
   * Load catalog from the bundled `catalog/default.json`.
   */
  static load(profile: TrustProfile = "standard"): Catalog {
    const catalogPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "catalog",
      "default.json",
    );
    const raw = readFileSync(catalogPath, "utf-8");
    const data: CatalogData = JSON.parse(raw);
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
   */
  buildDescription(): string {
    const lines = [
      "Execute actions in isolated containers via safeClaw.",
      "Each action runs in a Docker container — the host is never touched.",
      "",
      "Available actions:",
    ];

    for (const name of this.actionNames()) {
      const t = this.templates[name];
      const tier = t.approval_tier;
      const tierNote =
        tier === "human-confirm" ? " (requires approval)" : "";
      lines.push(`  - ${name}${tierNote}`);

      // Document parameters from schema
      const schema = t.parameter_schema;
      if (schema && typeof schema === "object") {
        const props = (schema as any).properties;
        const required: string[] = (schema as any).required ?? [];
        if (props) {
          for (const [pName, pSpec] of Object.entries(props)) {
            const spec = pSpec as Record<string, unknown>;
            const req = required.includes(pName) ? " (required)" : "";
            const type = spec.type ?? "any";
            lines.push(`      ${pName}: ${type}${req}`);
          }
        }
      }
    }

    return lines.join("\n");
  }
}
