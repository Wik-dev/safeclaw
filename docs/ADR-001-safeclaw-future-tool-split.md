# ADR-001: Split the `safeclaw` meta-tool into per-action tools

- **Status:** Proposed (deferred — revisit before catalog crosses ~25 actions)
- **Date:** 2026-05-05
- **Supersedes:** none
- **Related:** `docs/architecture.md` § 3.1, `docs/requirements.md` FR-002

## 1. Context

SafeClaw currently registers **one tool** with OpenClaw — `safeclaw({action, params})` — plus a second tool `safeclaw_check` for polling pending approvals. The `action` field is an enum drawn from `catalog/default.json`; the `params` field is a flat object whose properties are the union of every action's parameter schema.

This is the "meta-tool pattern" described in `docs/architecture.md` § 3.1. The original rationale was:

1. Single decision point — all actions through the same approval/rate-limit/policy pipeline.
2. Uniform error handling — one code path for all action types.
3. Catalog-driven extensibility — a new action requires only a JSON entry.
4. Smaller tool surface — one tool definition instead of N.

The catalog has grown from the initial set to ~16 actions and is expected to grow further as domain-specific tools are added (operational telemetry, vertical-specific dispatch, etc.). At some point the meta-tool's structural costs will exceed the convenience of one tool. This ADR captures the analysis and the recommended migration path.

## 2. Problem

Three of the four original rationales hold up well. The fourth — "smaller tool surface" — is **weaker than it appears** and degrades as the catalog grows.

### 2.1 The flat-union schema problem

To present one tool to the LLM, `meta-tool.ts` merges every action's parameter schema into a single `params` object using a first-write-wins strategy (`meta-tool.ts:95-109`):

```typescript
const allParamProps = {};
for (const name of actionNames) {
  const props = catalog.templates[name].parameter_schema?.properties ?? {};
  for (const [key, value] of Object.entries(props)) {
    if (!(key in allParamProps)) {
      allParamProps[key] = value;  // collision = silent loss
    }
  }
}
```

The resulting schema is **permissive by construction**: every property is optional at the schema level. Per-action required fields are documented in the tool *description* (a stitched prose blob), not in the schema. The harness cannot reject a malformed call before runtime.

Consequences:

- The LLM can emit `safeclaw({action: "write", params: {url: "..."}})` — schema-valid, semantically nonsense. The error surfaces only inside the proposal pipeline.
- If two actions both define a `timeout` field with different semantics (e.g. seconds vs. milliseconds), only the first action's schema wins. The losers' schema is silently wrong.
- A workaround comment at `meta-tool.ts:90-94` documents that OpenClaw's schema normalizer rejects top-level `oneOf`, which forced the flat-union design in the first place. Future schema features that would normally use polymorphism are blocked by the same constraint.

### 2.2 Description bloat

`catalog.buildDescription()` stitches every action's documentation into a single tool description. As actions accumulate, the description becomes a multi-KB unstructured prose blob. The LLM has to scan it linearly to recover the per-action parameter contract that the schema does not encode.

### 2.3 Token cost crossover

Below ~20 actions, the meta-tool is genuinely cheaper than N small tool definitions. Around 30 actions the two are roughly equivalent (the merged-params object plus stitched description grows quadratically with action count). Above ~50 actions, **the meta-tool is more expensive in tokens** than a corresponding split set of small focused tools.

### 2.4 Loss of per-tool harness affordances

With one tool registered, OpenClaw sees `safeclaw` for every call. The harness cannot natively apply per-tool rate limits, per-tool permission scopes, per-tool telemetry, or per-tool UI affordances. SafeClaw's backend can inspect `args.action` and apply policy internally, but the OpenClaw tooling layer is blind to action identity.

### 2.5 Where it starts to bite

Rough thresholds (depend on action overlap, parameter-name overlap, and model):

| Catalog size | Symptoms with meta-tool |
| --- | --- |
| 10–15 | None observable |
| 15–25 | First parameter-name collisions appear; description blob noticeable |
| 25–40 | LLM hallucinates parameter combinations; runtime error rate climbs |
| 40–60 | Description hard to navigate; selection accuracy starts dropping |
| 60+ | Materially broken — high error rate, expensive retries |

SafeClaw is at 16 actions today. The next batch of domain-specific tools puts the catalog into the 25–30 range — the inflection zone where the structural costs start exceeding the convenience.

## 3. Decision

**Defer the split, but commit to the design.** When the catalog reaches ~25 actions or the first observed parameter-name collision occurs (whichever is sooner), replace the single `safeclaw` meta-tool with **N per-action tools generated from the catalog by a registration loop**.

The split preserves all four original rationales:

| Rationale | Meta-tool | Split |
| --- | --- | --- |
| Single decision point | ✅ router in `meta-tool.ts` | ✅ shared `submitAction()` backend |
| Uniform error handling | ✅ one `execute` body | ✅ one `submitAction()` body |
| Catalog-driven extensibility | ✅ JSON edit only | ✅ JSON edit only (loop iterates catalog) |
| Smaller tool surface | ✅ at small scale, ❌ at scale | ➖ N tools, but each is small and focused |

### 3.1 Target architecture

```
src/
├── meta-tool.ts          → refactored to expose:
│                            - submitAction(action, params, signal)  (shared backend)
│                            - makeActionTool(action, template)       (factory)
├── index.ts              → adds the registration loop
├── catalog.ts            → unchanged
├── kernel-client.ts      → unchanged
├── trust-profiles.ts     → unchanged
└── ...
catalog/default.json      → unchanged structure, source of truth
```

Registration in `index.ts`:

```typescript
for (const action of catalog.actionNames()) {
  const tool = makeActionTool(action, catalog.templates[action], submitAction);
  api.registerTool(tool, { name: `safeclaw_${action}` });
}
```

The factory:

```typescript
function makeActionTool(action, template, submitAction) {
  return {
    name: `safeclaw_${action}`,
    description: template.description,
    parameters: template.parameter_schema,
    execute: (id, params, signal) => submitAction(action, params, signal),
  };
}
```

`safeclaw_check` remains unchanged.

**No per-action `.ts` source files.** Each tool is a runtime object produced by the factory. The catalog stays the single contributor entrypoint.

### 3.2 What changes

- `meta-tool.ts:95-109` — schema-merging loop is removed.
- `meta-tool.ts:90-94` — workaround comment for the OpenClaw normalizer becomes obsolete (no union schema to express).
- `meta-tool.ts:111-129` — the single tool definition is replaced by the factory.
- `index.ts` — gains the registration loop (~5 lines).
- Tests in `tests/` — unit tests for `submitAction` are unchanged; new factory test verifies that a catalog entry produces a correctly-shaped tool.

### 3.3 What stays the same

- `catalog/default.json` — structure and contents unchanged.
- `submitAction` body — identical to the current `execute` body of the meta-tool (proposal submission, race logic, pending-store handling, `effectiveApprovalTier`).
- `formatResult` — unchanged.
- `effectiveApprovalTier` — unchanged.
- `kernel-client.ts`, `catalog.ts`, `session-map.ts`, `pending-store.ts`, `approval-handler.ts`, `trust-profiles.ts` — unchanged.
- The proposal pipeline behavior on the Validance side — unchanged (same REST contract).
- `safeclaw_check` — unchanged.

## 4. Consequences

### 4.1 Positive

- **Schema correctness.** Each tool has its own typed schema; OpenClaw rejects malformed calls before they reach the backend. No more silent param collisions.
- **Cleaner code.** The schema-merging loop and the OpenClaw normalizer workaround both disappear. Net line count: roughly the same or slightly less.
- **Per-tool harness affordances.** OpenClaw sees `safeclaw_write`, `safeclaw_browser`, etc. as distinct tools — enables per-tool telemetry, per-tool permission scopes, per-tool UI hooks at the harness layer.
- **Better LLM ergonomics.** Per-tool descriptions stay focused. The LLM picks `safeclaw_browser` from a name + 2-line description rather than from a 40-line stitched prose blob.
- **Token cost scales linearly** with action count, with no quadratic blowup.
- **Lazy registration becomes trivial.** A trust profile that forbids networked tools can simply skip those catalog entries during the registration loop. With the meta-tool, this requires dynamically rebuilding the merged schema.
- **Hermetic heterogeneous tools.** Domain-specific tools (operational, vertical-specific) don't pollute the parameter surface of unrelated tools (file ops, web ops). Each tool's schema reflects only its own contract.

### 4.2 Negative

- **More tool definitions in the LLM's context** at small catalog sizes. Below ~20 actions, the per-call token cost of the split set is slightly higher than the meta-tool. Above that, split is cheaper.
- **The single `safeclaw` brand goes away** as a tool name. Mitigated by consistent `safeclaw_*` prefix.
- **Existing prompts/agent personas** that mention "the safeclaw tool" need updating if they reference it by name. None ship with this repo today.
- **Selection accuracy at very large N (100+ tools)** is not solved by either design. Mitigations (namespacing, lazy registration, hierarchical tools) apply equally — but are easier to wire on top of split.

### 4.3 Neutral

- **Contributor flow is unchanged.** Adding a new tool is a catalog JSON edit in either case. Restart the gateway, the tool appears.
- **Catalog format is unchanged.** No migration of `catalog/default.json` is required.
- **Validance-side behavior is unchanged.** The proposal pipeline, approval gate, learned policy, and audit trail all see the same wire contract.

## 5. Alternatives considered

### 5.1 Keep the meta-tool indefinitely

Status quo. Defensible at the current catalog size. Becomes structurally fragile as the catalog grows toward 25+ actions, with a risk of silent param-collision bugs that are expensive to diagnose post-hoc.

### 5.2 Split now (eager migration)

Same end state as the proposed decision, but executed before the catalog has grown. Lower urgency; defers the work that needs to be done anyway. Justifiable if there is upcoming work that would benefit from the split (per-tool telemetry, per-tool trust scoping). Not justified by today's 16-action catalog alone.

### 5.3 Hybrid — group related actions into sub-meta-tools

E.g. `safeclaw_fs({action: "write"|"edit"|"apply_patch", params})`, `safeclaw_web({action: "search"|"fetch", params})`, etc. Reduces the merged-schema noise within each group but reintroduces the same structural problems within each sub-tool as the per-group action count grows. Worse: it adds a level of taxonomy that has to be maintained by hand. Rejected.

### 5.4 Switch to JSON-Schema `oneOf` for action-discriminated parameters

Conceptually clean. Blocked by the OpenClaw schema normalizer, per the existing comment at `meta-tool.ts:90-94`. Would require changes upstream in OpenClaw's tool-schema handling. Out of scope for this ADR.

### 5.5 Hierarchical tools (a "navigator" tool)

A meta-meta-tool that the LLM consults to discover the relevant action tool, which it then calls in a second turn. Solves selection accuracy at 100+ tools but adds a turn of latency and a second LLM decision. Premature for SafeClaw's catalog size; revisit only if SafeClaw exposes hundreds of tools.

## 6. Migration plan (when triggered)

1. **Refactor `meta-tool.ts`** — extract the `execute` body into a free function `submitAction(action, params, signal)`. Add `makeActionTool(action, template, submitAction)`. Keep `formatResult` and `effectiveApprovalTier` exported as today.
2. **Update `index.ts`** — replace the single `api.registerTool(createSafeClawTool(...))` call with a `for (const action of catalog.actionNames())` registration loop.
3. **Update `tests/`** — add a factory test (catalog entry → well-formed tool definition). Existing backend tests for proposal submission carry over unchanged via `submitAction`.
4. **Update `docs/architecture.md` § 3.1** — replace the single-meta-tool description with the per-action description; reference this ADR.
5. **Update `docs/requirements.md` FR-002** — reword to "Register one tool per catalog action under the `safeclaw_*` namespace" and reference this ADR.
6. **Rebuild `dist/`**, smoke test against a running gateway, then publish a minor npm version (the public tool name set changes — semver-minor at minimum, document in CHANGELOG).
7. **Communicate to OpenClaw plugin consumers** — the `safeclaw` tool name no longer exists; tools are `safeclaw_<action>`. Anyone with persona prompts or trust scopes that hard-code `safeclaw` must update.

## 7. Trigger conditions for executing the migration

Execute the split when **any** of the following occurs:

- Catalog reaches **~25 actions** total, or the next planned batch will cross that threshold.
- The first **silent parameter-name collision** is observed (two catalog entries with overlapping param names and different schemas — even harmless cases are a signal).
- A roadmap item requires **per-tool harness affordances** (e.g. fine-grained trust scoping per tool, per-tool UI in the OpenClaw client, per-tool telemetry dashboards).
- Token cost in production exceeds the equivalent for an N-tool registration (measurable from actual tool-call payloads).

Until then, the meta-tool remains the registered design and `docs/architecture.md` § 3.1's "future optimization" note points at this ADR.

## 8. References

- `docs/architecture.md` § 3.1 — current meta-tool design and the future-optimization note.
- `docs/requirements.md` FR-002 — current requirement for a single meta-tool.
- `src/meta-tool.ts` — implementation, including the schema-merging loop and OpenClaw normalizer workaround.
- `src/index.ts` — current single-tool registration site.
- OpenClaw plugin authoring docs — `https://docs.openclaw.ai/tools/plugin` — for the per-action registration convention used by bundled plugins (e.g. `memory-wiki`).
