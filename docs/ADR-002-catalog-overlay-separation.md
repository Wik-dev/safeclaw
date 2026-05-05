# ADR-002: Separate the public default catalog from deployment-specific overlays

- **Status:** Accepted (2026-05-05) — implementation next. Validance-side instance split deliberately deferred: the kernel's existing controls (approval gate, rate limits, network policy, container isolation, audit chain) are the load-bearing defense for the hosted endpoint. Catalog content is a discoverability concern, not a security boundary, so the SafeClaw npm side is sufficient until binary distribution lands.
- **Date:** 2026-05-05
- **Supersedes:** none
- **Related:** `docs/architecture.md` § 3.2, `docs/ADR-001-safeclaw-future-tool-split.md`, `catalog/default.json`, `src/catalog.ts`

## 1. Context

`catalog/default.json` is the source of truth for what tools SafeClaw exposes to OpenClaw. It is bundled into the published npm package (`@validance/safeclaw`) and shipped to every plugin consumer.

Today the bundled catalog contains **22 templates** from two distinct concerns:

- **OpenClaw-native replacements (16):** `exec`, `write`, `edit`, `apply_patch`, `browser`, `web_search`, `web_fetch`, `message`, `sessions_send`, `cron`, `process`, `image`, `tts`, `canvas`, `nodes`, `gateway`. These exist to deny dangerous OpenClaw built-ins and route equivalent capability through the proposal pipeline. They are universally relevant — every SafeClaw consumer needs them.
- **Deployment-specific entries (6):** `fleet_status_query`, `fleet_underclock`, `fleet_schedule_maintenance`, `fleet_emergency_shutdown`, `fleet_pipeline_status`, `knowledge_query`. These exist for a specific operational deployment. They have no meaning outside that deployment context.

Mixing the two in the public default produces three observable problems for npm consumers and one cleanliness problem for the codebase.

## 2. Problem

### 2.1 Domain leak in a generic plugin

The plugin's public positioning is "OpenClaw safety layer for arbitrary Validance deployments." The public `catalog/default.json` contradicts that positioning by exposing entries tied to a specific operational vertical. Anyone reading the catalog learns about a deployment context that has no business being part of the published artifact.

This is a one-way door. Once an entry ships in the npm tarball, it is permanently part of the package's history (npm registry, mirror sites, search indexes).

### 2.2 Noise for generic adopters

A user who installs `@validance/safeclaw` against their own Validance instance gets the deployment-specific entries in their LLM's tool list. They:

- Have no Validance-side workflows registered for those actions, so calls fail at proposal time with "image not found" or "workflow not registered" errors.
- See unfamiliar tool names in the catalog and have to figure out whether they are relevant.
- Inherit deployment-specific tier overrides (see § 2.4) they did not opt into.

### 2.3 Free capability inheritance against a public Validance endpoint

If a generic adopter points their local OpenClaw + SafeClaw at a public Validance endpoint that *does* host the deployment-specific workflows (e.g. a hosted demo at `api.validance.io`), they receive the deployment-specific actions as **callable tools** in their LLM context.

Authentication, session isolation, and per-session policy on the Validance side are the right defenses against unauthorized *execution* — but the catalog itself is the LLM-facing **action surface**. Shipping a catalog that advertises deployment-private actions makes them visible and reachable in a way that requires server-side defense in depth even for cases that should not be in the surface in the first place.

### 2.4 Hardcoded deployment-specific overrides in shared code

`src/catalog.ts:38–69` defines `TRUST_OVERRIDES` as a static map. Two of its entries are deployment-specific:

```typescript
const TRUST_OVERRIDES: Record<TrustProfile, Record<string, string>> = {
  conservative: {
    ...
    fleet_status_query: "human-confirm",  // deployment-specific
  },
  "power-user": {
    ...
    fleet_underclock: "auto-approve",     // deployment-specific
  },
};
```

These names appear in the public `src/` tree. Even if `catalog/default.json` were stripped, the override map would still leak the domain. Worse, the override structure is hard-coded — overlay catalog entries cannot supply their own per-profile tier rules without editing this file.

## 3. Decision

Adopt a **two-layer catalog with overlay loading** and make trust-tier overrides **data-driven per template entry**.

### 3.1 Two-layer catalog

```
catalog/default.json         ← public, shipped in npm tarball
                                ONLY OpenClaw-native replacements (16 entries)

catalog/<overlay>.json       ← optional, NOT in the npm tarball
                                Loaded from a path supplied by deployment config
                                Contains deployment-specific templates
                                Lives outside this repo (private deploy repo,
                                operator's filesystem, secret management, etc.)
```

The published artifact contains only the universally relevant entries. Deployment-specific entries live in an overlay file that the operator supplies at deployment time.

### 3.2 Overlay loading contract

A new optional field is added to the plugin configuration accepted by `register(api, config)`:

```jsonc
// openclaw.plugin.json or equivalent runtime config
{
  "config": {
    "kernelUrl": "https://api.validance.io",
    "trustProfile": "standard",
    "catalogOverlayPath": "/etc/safeclaw/local-overlay.json"   // optional
  }
}
```

Alternative: an env var `SAFECLAW_CATALOG_OVERLAY=/path/to/overlay.json` for environments where editing the plugin config is harder than setting an env var.

`Catalog.load()` becomes:

```typescript
static load(profile: TrustProfile = "standard", overlayPath?: string): Catalog {
  const data: CatalogData = JSON.parse(readFileSync(defaultPath, "utf-8"));
  if (overlayPath) {
    const overlay: CatalogData = JSON.parse(readFileSync(overlayPath, "utf-8"));
    Object.assign(data.templates, overlay.templates);   // overlay wins on key collision
    Object.assign(data.images, overlay.images);
  }
  return new Catalog(data, profile);
}
```

**Conflict policy:** overlay wins on key collision. Operators who genuinely need to override a default entry (e.g. tighten `web_fetch` rate limits for their deployment) can do so by re-declaring the key in the overlay.

**Validation:** the loader validates overlay entries with the same schema as default entries. Missing required fields fail at load time with a clear error. Unknown fields are ignored (forward compatibility).

**Failure modes:**

- Overlay path supplied but file missing → load error at startup, plugin fails to register. (Operator misconfiguration, fail loud.)
- Overlay path not supplied → load only the default. (Default behavior for generic adopters.)
- Overlay file malformed JSON → load error at startup, plugin fails to register.

### 3.3 Per-entry tier overrides

Move the trust-profile override semantics out of `src/catalog.ts` and into the catalog templates themselves:

```jsonc
{
  "templates": {
    "exec": {
      "approval_tier": "human-confirm",
      "tier_overrides": {
        "power-user": "auto-approve"
      },
      ...
    },
    "browser": {
      "approval_tier": "human-confirm",
      "tier_overrides": {
        "power-user": "auto-approve"
      },
      ...
    }
  }
}
```

`src/catalog.ts:38–69` shrinks to only the **profile-wide blanket rules** (e.g. `conservative` always promotes auto-approve to human-confirm; `gateway` is always-deny in conservative). Per-entry overrides ride with the entry — including overlay entries.

Algorithm in `Catalog` constructor:

1. Start with `entry.approval_tier` from the catalog.
2. Apply blanket profile rule (e.g. conservative → confirm everything not always-deny).
3. Apply `entry.tier_overrides[profile]` if present.
4. Result is the effective tier for this entry under this profile.

This lets overlay entries declare their own per-profile semantics without touching shared code.

## 4. Consequences

### 4.1 Positive

- **No domain leak.** The public npm package contains only universally relevant entries. Deployment-specific entries stay outside the public surface.
- **Clean adoption story.** Generic adopters get exactly the 16 OpenClaw-native replacements. No phantom tools, no failed proposals from missing workflows.
- **Defense in depth restored.** A generic adopter pointing at a public Validance endpoint cannot accidentally enumerate or invoke deployment-specific actions through their catalog.
- **Self-contained domain extensions.** Operators (including this project) ship their domain catalog as a separate file with full control over location, access, and lifecycle. Adding a new vertical = new overlay file, not a npm release.
- **Composable trust profiles.** Per-entry `tier_overrides` mean overlay entries can declare their own profile semantics. The shared override table no longer needs to know about every domain.
- **Smaller npm tarball.** Drops 6 templates and their associated documentation/schema bytes from the published artifact.
- **Reduced collision risk.** With domain-specific entries out of the default surface, parameter-name collisions between native and domain entries (a concern documented in ADR-001) cannot occur in the published artifact.

### 4.2 Negative

- **Operators must supply an overlay** to recover domain-specific tools. Documented setup step (one-line config), but it is a new step.
- **Two configuration layers** instead of one. Slightly more operational surface to understand.
- **Per-entry `tier_overrides` is a schema change to the catalog format.** Backward compatible (field is optional, absent = no overrides), but operators reading existing overlay files in the wild must understand the new field.

### 4.3 Neutral

- **No change to the wire contract with Validance.** Proposals submitted to the API are identical regardless of whether the entry came from default or overlay.
- **No change to the `safeclaw_check` tool.**
- **No change to per-action behavior** for OpenClaw-native entries.

## 5. Alternatives considered

### 5.1 Status quo — keep mixing in `default.json`

Defensible only if SafeClaw is positioned as a single-tenant artifact for one specific deployment. It is not — it is published to npm under a generic name, which makes the leak structural rather than incidental. Rejected.

### 5.2 Move deployment-specific entries to a separate template repo, keep one-layer load

Operators copy/fork a separate `safeclaw-fleet-overlay` repo and replace the bundled `catalog/default.json` at deploy time. Works, but turns a config decision into a fork: every plugin upgrade requires merging upstream `default.json` changes into the operator's fork. Rejected in favor of additive overlay.

### 5.3 Multiple plugins (`@validance/safeclaw-core`, `@validance/safeclaw-fleet`)

Publish core and domain-specific plugins separately. Each registers its own catalog. Architecturally clean but multiplies the maintenance, version-coordination, and OpenClaw-side configuration burden. The overlay pattern delivers the same separation with one plugin and one config field. Defer this option until a domain has a meaningful plugin author other than this project.

### 5.4 Lazy registration based on Validance discovery

At plugin startup, query the Validance instance for available workflows and register only the matching catalog entries. Solves the noise problem (no phantom tools) but does not solve the leak (the catalog file still ships with everything) and adds a startup dependency on a network round-trip to Validance. Worth considering as a refinement on top of overlays, not a replacement.

### 5.5 Server-side catalog API

Validance exposes a `GET /api/catalog` endpoint; SafeClaw fetches the catalog at startup. Cleanly inverts the dependency (Validance owns what is callable) but creates a hard runtime dependency between SafeClaw startup and Validance reachability, and shifts the overlay management problem to the server side without removing it. Rejected for now.

## 6. Migration plan

### Phase 1 — code changes (no behavior change for current deployment)

1. **Add overlay loading to `Catalog.load()`** (`src/catalog.ts`). Optional `overlayPath` parameter. Read from config or env var.
2. **Refactor `TRUST_OVERRIDES`** to handle only blanket profile rules. Read per-entry overrides from `entry.tier_overrides` in the constructor.
3. **Update `src/index.ts`** to pass the overlay path from plugin config to `Catalog.load()`.
4. **Add a backward-compatibility shim:** if `catalog/default.json` still contains an entry that has a hardcoded override in the old `TRUST_OVERRIDES` table, the old override applies. Lets us ship code first, migrate the catalog second.
5. **Tests:** load default only; load default + overlay; overlay key collision; missing overlay file fails loud; per-entry override resolution under each profile.

At this point both files exist with identical contents and the new code path is exercised but produces identical behavior.

### Phase 2 — split the catalog (behavior change for current deployment)

6. **Create the overlay file** `notes/fleet-overlay.json` (gitignored) with the 6 deployment-specific entries plus their `tier_overrides`.
7. **Strip `catalog/default.json`** to the 16 OpenClaw-native entries.
8. **Remove the deployment-specific lines** from `TRUST_OVERRIDES` in `src/catalog.ts:55–57, 64–67`.
9. **Update the running deployment** to point `catalogOverlayPath` (or the env var) at the overlay file.
10. **Restart the gateway**, verify the agent still has the 22 actions it had before, and that a stock plugin install (no overlay) sees only 16.

### Phase 3 — documentation

11. **Update `docs/architecture.md` § 3.2** to describe the two-layer catalog.
12. **Update `docs/requirements.md`** with a new FR (e.g. FR-027 "Support optional catalog overlay loaded from deployment config").
13. **Add a section to README** describing the overlay mechanism for operators who want to add their own tools.
14. **Mark this ADR as Accepted** when phases 1 and 2 are complete.

### Phase 4 — npm publish

15. Bump npm minor version (additive feature: overlay support; subtractive change to the public catalog set). Document the catalog removal in CHANGELOG.
16. Publish.

## 7. Interaction with ADR-001

ADR-001 (split meta-tool into per-action tools) and this ADR are **complementary and order-independent**, but together they yield the cleanest result:

- This ADR removes domain-specific entries from the public surface (correctness of *what* is exposed).
- ADR-001 changes *how* exposed entries are presented to the LLM (typed per-action tools instead of flat union).

If both are implemented, the registration loop in ADR-001 § 3.1 iterates a catalog that is already the union of `default + overlay`. No additional design is needed — overlay entries register as `safeclaw_<entry>` tools the same way default entries do.

If only this ADR is implemented (without ADR-001), the meta-tool's merged-params schema becomes structurally cleaner because the parameter union is restricted to the 16 OpenClaw-native entries and whatever the operator's overlay adds. Domain parameters (e.g. `vehicle_id`) no longer pollute the public default's flat schema.

If only ADR-001 is implemented (without this ADR), per-action tools clean up the schema-collision and description-bloat problems but still leak domain entries in the published catalog and in `TRUST_OVERRIDES`. The leak problem is independent of the tool-shape problem.

**Recommendation:** ship this ADR first (urgent, affects every consumer today), then ADR-001 when its trigger conditions fire.

## 8. Trigger conditions

Phase 1 (code changes) can ship at any time — it is purely additive and changes no behavior. Phase 2 (catalog split) should ship in the same release or shortly after. There is no reason to defer.

The argument for shipping immediately:

- Each day the current `catalog/default.json` ships, more downloads of the npm package include the deployment-specific entries. The leak compounds with download count.
- The migration is small (one file split, one code change, one documentation update).
- It removes a class of correctness bugs (parameter collisions between domain and native entries) before they can occur.

## 9. References

- `catalog/default.json` — current 22-entry catalog mixing native and deployment-specific.
- `src/catalog.ts` — current single-layer loader and hardcoded `TRUST_OVERRIDES`.
- `docs/architecture.md` § 3.2 — current catalog documentation.
- `docs/ADR-001-safeclaw-future-tool-split.md` — the parallel decision on tool registration shape.
- `docs/requirements.md` — FR-004 ("Load tool catalog from `catalog/default.json` at plugin registration") will need a companion FR for overlay loading.
