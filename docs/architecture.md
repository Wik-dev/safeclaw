# SafeClaw — Architecture

> **Audience:** Plugin developers, OpenClaw users, security reviewers.

---

**Related documents:** [requirements.md](requirements.md) · [risk-assessment.md](risk-assessment.md) · [validance-integration.md](validance-integration.md)

## 1. What SafeClaw Does

SafeClaw (`@validance/safeclaw`) is an OpenClaw plugin that intercepts dangerous tool calls and reroutes them through isolated Docker containers. The LLM never executes directly on the host — every write, exec, browser action, and message goes through a validated execution engine that enforces approval gates, rate limits, and audit trails.

```
LLM Agent
  │  calls safeclaw({action: "exec", params: {command: "npm test"}})
  ▼
┌──────────────────────────────────────────────────┐
│  OpenClaw                                        │
│  ┌────────────────────────────────────────────┐  │
│  │  SafeClaw plugin (@validance/safeclaw)     │  │
│  │  safeclaw meta-tool + safeclaw_check tool  │  │
│  │  /sc-approve command                       │  │
│  └──────────────────┬─────────────────────────┘  │
│                     │ HTTP (POST /api/proposals)  │
└─────────────────────┼────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────┐
│  Execution Engine (pluggable)                    │
│  catalog → rate-limit → policy → approval gate   │
│  → secrets → worker → result                     │
└──────────────────┬───────────────────────────────┘
         ┌─────────┼─────────┐
         ▼         ▼         ▼
   ┌──────────┐ ┌────────┐ ┌──────────┐
   │ sandbox  │ │ comms  │ │ browser  │
   │(persist) │ │(1-shot)│ │(persist) │
   └──────────┘ └────────┘ └──────────┘
```

> **Key principle:** The host is never touched. All dangerous operations run inside Docker containers with controlled volume mounts, network policies, and resource limits.

## 2. Repository Structure

```
safeclaw/
├── src/
│   ├── index.ts              # Plugin entry: register(api), /sc-approve command
│   ├── meta-tool.ts          # safeclaw meta-tool (execute → POST /api/proposals)
│   ├── kernel-client.ts      # HTTP client for execution engine (native fetch)
│   ├── catalog.ts            # Local catalog + trust profile tier overrides
│   ├── session-map.ts        # sessionKey → session_hash (SHA-256)
│   ├── pending-store.ts      # In-memory store linking proposalId ↔ approvalId
│   ├── approval-handler.ts   # Webhook handler + resolver + safeclaw_check tool
│   └── trust-profiles.ts     # conservative / standard / power-user tier overlays
├── catalog/
│   └── default.json          # Tool catalog (16 templates, 4 Docker images)
├── docker/
│   └── docker-compose.yml    # Execution engine + PostgreSQL compose
├── bin/
│   └── safeclaw.mjs          # CLI: npx @validance/safeclaw start|stop|logs
├── tests/
│   ├── unit/                  # Vitest unit tests (no HTTP)
│   └── integration/           # Plugin → live Validance API tests
├── docs/
│   ├── architecture.md       # This document
│   ├── validance-integration.md  # Engine-specific integration details
│   ├── requirements.md       # Functional and non-functional requirements
│   ├── risk-assessment.md    # Security risk register
│   └── development-plan.md   # Implementation roadmap
├── openclaw.plugin.json      # Plugin manifest (required by OpenClaw)
├── package.json              # @validance/safeclaw npm package
├── tsconfig.json             # TypeScript config (ES2022, strict)
├── README.md                 # Project overview
└── CLAUDE.md                 # Claude Code instructions
```

## 3. How It Works

### 3.1 Single Meta-Tool Pattern

SafeClaw registers **one tool** (`safeclaw`) with OpenClaw instead of 16 individual tools. The LLM calls `safeclaw({action, params})` and SafeClaw translates to a proposal request.

Why one tool instead of 16:
- **Single decision point** — all actions go through the same approval/rate-limit/policy pipeline
- **Uniform error handling** — one code path for all action types
- **Catalog-driven** — adding a new action requires only a catalog entry, not a new tool registration
- **Smaller tool surface** — the LLM sees one tool with an `action` enum, not 16 separate tool definitions

> **Future optimization (deferred):** the "smaller tool surface" rationale is weaker than it appears. A flat `params` object whose validity depends on the `action` value gives the LLM less typed structure than 16 well-typed individual tools would. OpenClaw's bundled plugins (e.g. `memory-wiki`) follow the one-tool-per-action convention. A future refactor would split the meta-tool into N individual tools sharing the same proposal backend — preserving the single decision point and catalog-driven extensibility while aligning with OpenClaw conventions and improving LLM call reliability. Trigger conditions, target architecture, and migration plan are captured in [ADR-001 — SafeClaw future tool split](ADR-001-safeclaw-future-tool-split.md).

A second tool, `safeclaw_check`, is registered for polling the result of pending (human-confirm) actions.

### 3.2 Tool Catalog

The catalog (`catalog/default.json`) defines 16 templates across 4 Docker images and 3 approval tiers.

| Action | Image | Approval Tier | Timeout | Rate Limit | Persistent | Notes |
|--------|-------|---------------|---------|------------|------------|-------|
| `exec` | sandbox | human-confirm | 120s | 200/session | Yes | Shell commands in /workspace |
| `write` | sandbox | auto-approve | 30s | 500/session | No | Write file to workspace |
| `edit` | sandbox | auto-approve | 30s | 500/session | No | Find-and-replace in file |
| `apply_patch` | sandbox | auto-approve | 30s | 500/session | No | Apply unified patches |
| `browser` | browser | human-confirm | 3600s | 30/session | Yes | Headless browser automation |
| `web_search` | web | auto-approve | 30s | 100/session | No | Search API (needs SEARCH_API_KEY) |
| `web_fetch` | web | auto-approve | 60s | 100/session | No | HTTP GET/POST |
| `message` | comms | human-confirm | 30s | 20/session | No | 53 actions, gateway proxy (needs SMTP_PASSWORD for email) |
| `sessions_send` | comms | human-confirm | 30s | 50/session | No | Inter-session messaging |
| `cron` | sandbox | human-confirm | 30s | 10/session | Yes | Schedule commands (6 actions) |
| `process` | sandbox | auto-approve | 30s | 200/session | Yes | Background process management |
| `image` | sandbox | auto-approve | 120s | 50/session | No | Vision analysis (needs VISION_API_KEY) |
| `tts` | sandbox | auto-approve | 60s | 50/session | No | Text-to-speech |
| `canvas` | comms | human-confirm | 30s | 100/session | No | 7 actions, gateway proxy |
| `nodes` | comms | human-confirm | 120s | 100/session | No | 20 actions, gateway proxy |
| `gateway` | — | always-deny | — | — | — | Excluded from tool enum |

**Docker images:**

| Image | Container |
|-------|-----------|
| `sandbox` | `validance-sandbox:latest` — general-purpose execution |
| `browser` | `validance-browser:latest` — headless Chromium |
| `web` | `validance-web:latest` — HTTP/search client |
| `comms` | `validance-comms:latest` — email/messaging |

### 3.3 Trust Profiles

Trust profiles override the default approval tier per action, letting users trade safety for convenience.

| Profile | exec | browser | write/edit | web_search/web_fetch | message/sessions_send | cron | image/tts/canvas/nodes | gateway |
|---------|------|---------|------------|---------------------|----------------------|------|----------------------|---------|
| **conservative** | human-confirm | human-confirm | human-confirm | human-confirm | human-confirm | human-confirm | human-confirm | always-deny |
| **standard** (default) | human-confirm | human-confirm | auto-approve | auto-approve | human-confirm | human-confirm | auto-approve | always-deny |
| **power-user** | auto-approve | auto-approve | auto-approve | auto-approve | human-confirm | human-confirm | auto-approve | always-deny |

**Tools that stay local** (not routed through SafeClaw): `read`, `sessions_list`, `sessions_history`, `session_status`, `agents_list`, `subagents`, `sessions_spawn`. These are read-only or session-management operations that pose no host risk.

## 4. Approval Flow

### 4.1 Auto-Approve Path

For actions with `auto-approve` tier, the meta-tool makes a single blocking HTTP call to the execution engine, passing the agent's abort signal. The engine validates, executes, and returns the result in one round-trip.

```
Agent calls safeclaw({action: "write", params: {path: "test.txt", content: "hello"}})
  → meta-tool sees auto-approve tier
  → POST /api/proposals (blocking, with abort signal)
  → engine validates → executes in sandbox container → returns result
  → meta-tool returns formatted output to agent
```

### 4.2 Human-Confirm Path

For actions requiring human approval, the meta-tool uses a background promise pattern:

```
Agent calls safeclaw({action: "exec", params: {command: "ls /tmp"}})
  → meta-tool sees human-confirm tier
  → fires submitProposal() in background (NO abort signal)
  → stores entry in pendingProposals (keyed by proposalId UUID)
  → 500ms race: checks if engine auto-approved server-side (learned policy)
  │
  ├─ If resolved in 500ms: returns result directly (learned policy hit)
  │
  └─ If still pending: returns approval prompt to agent
       "Action requires approval: exec
        /sc-approve <proposalId> allow-once"

Engine (background):
  → creates an approval record
  → fires webhook to /safeclaw/approval-notify?proposalId=<uuid>
  → webhook handler links approval_id ↔ proposalId in pending store

User: /sc-approve <proposalId> allow-once
  → deterministic command handler (zero LLM involvement)
  → resolves approval in engine
  → waits up to 30s for execution result
  → returns: "Approved & executed: <output>"

OR: Agent calls safeclaw_check({proposal_id: "<uuid>"})
  → waits up to 15s for background promise to resolve
  → returns result or "still waiting" message
```

The `/sc-approve` command accepts four decisions:
- `allow-once` — approve this specific action
- `allow-always` — approve and create a learned policy rule (future matching actions auto-approve)
- `deny` — deny this specific action
- `deny-always` — deny and create a learned policy rule (future matching actions auto-deny)

### 4.3 Always-Deny

Actions with `always-deny` tier (currently only `gateway`) are excluded from the meta-tool's `action` enum entirely. The LLM cannot call them — they do not appear in the tool description.

## 5. Components

| Module | Purpose | Key Exports | Dependencies |
|--------|---------|-------------|--------------|
| `index.ts` | Plugin entry point | `register(api)` — registers all tools, routes, commands, event handlers | All other modules |
| `meta-tool.ts` | Single LLM-callable tool | `createSafeClawTool()`, `formatResult()`, `SafeClawConfig` | kernel-client, catalog, session-map, pending-store |
| `kernel-client.ts` | HTTP client for execution engine | `KernelClient` class (submitProposal, resolveApproval, listPolicies, revokePolicy, cleanupSession, healthCheck) | None (native fetch) |
| `catalog.ts` | Catalog loader + trust profile application | `Catalog` class (load, actionNames, buildDescription) | trust-profiles (type only), fs, path |
| `session-map.ts` | Session key → stable hash | `sessionHash()` — SHA-256 with `safeclaw:` prefix | None (native crypto) |
| `pending-store.ts` | In-memory proposal ↔ approval linking | `pendingProposals` Map, `gcPending()` | None (globalThis singleton) |
| `approval-handler.ts` | Webhook receiver + resolver + check tool | `createApprovalNotifyHandler()`, `createApprovalResolver()`, `createApprovalCheckTool()` | kernel-client, pending-store, meta-tool (formatResult) |
| `trust-profiles.ts` | Trust profile types and tool lists | `TrustProfile` type, `LOCAL_TOOLS`, `DENIED_TOOLS` | None |

## 6. Design Choices & Rationale

| Choice | Rationale |
|--------|-----------|
| **10-minute pending expiry** | Approval window balances memory consumption vs. usability. Most approvals happen within seconds; 10 minutes covers slow human review without leaking entries indefinitely. |
| **500ms auto-approve race** | Catches engine-side auto-approvals (learned policy match, catalog mismatch) without adding perceptible latency to the auto-approve path. If the engine resolves within 500ms, the agent gets an immediate result instead of a stale approval prompt. |
| **15s check tool timeout** | Long enough for execution to complete after approval was just granted; short enough for agent loop responsiveness. The agent retries if still pending. |
| **30s resolver timeout** | Used by `/sc-approve` and the gateway resolver. Longer because the user explicitly triggered it and is willing to wait for the result. |
| **5-minute proposal timeout** | Server-side (engine-enforced). Covers long-running `exec` commands. The engine aborts proposals that exceed this. |
| **300s (5-min) client-side HTTP timeout** | `KernelClient` constructor default. Must be >= the engine's proposal timeout to avoid premature client-side aborts. |
| **`globalThis` singleton for pending store** | OpenClaw's plugin loader may resolve modules through different paths (CJS/ESM interop, symlinks). `globalThis.__safeclaw_pendingProposals__` guarantees a single shared Map across all resolution paths. |
| **SHA-256 session hash with `safeclaw:` prefix** | Stable key derivation from opaque OpenClaw session keys. The `safeclaw:` prefix provides namespace isolation — other consumers of the same execution engine won't collide. Results are cached for process lifetime. |
| **Zero external runtime dependencies** | Reduced attack surface, zero supply-chain risk at runtime. Uses only Node.js built-ins: `fetch` (18+), `crypto`, `fs`, `path`, `http`. Dev dependencies (TypeScript, vitest) are build-time only. |
| **No abort signal on human-confirm background promise** | The background `submitProposal()` call must survive agent context switches. If the agent moves on and comes back, the promise is still waiting for approval. Passing an abort signal would kill it prematurely. |
| **Deterministic `/sc-approve` command** | Zero LLM involvement in the approval decision. The user types the command directly — no risk of the LLM approving its own actions. |

## 7. Configuration Reference

| Parameter | Default | Source | Description |
|-----------|---------|--------|-------------|
| `kernelUrl` | `http://localhost:7400` | Plugin config / env | Execution engine HTTP URL |
| `trustProfile` | `standard` | Plugin config | Approval tier preset: `conservative`, `standard`, `power-user` |
| `gatewayPort` | `18789` | Plugin config | OpenClaw gateway port for approval webhook callbacks |
| `gatewayHost` | `localhost` | Plugin config | Host/IP for webhook URL as seen from the engine container (use Docker bridge IP if needed) |

**Plugin manifest** (`openclaw.plugin.json`):
```json
{
  "id": "@validance/safeclaw",
  "name": "SafeClaw — Containerized Execution",
  "version": "0.1.0",
  "configSchema": {
    "properties": {
      "kernelUrl":    { "type": "string",  "default": "http://localhost:7400" },
      "trustProfile": { "type": "string",  "enum": ["conservative", "standard", "power-user"], "default": "standard" },
      "gatewayPort":  { "type": "number",  "default": 18789 },
      "gatewayHost":  { "type": "string",  "default": "localhost" }
    }
  }
}
```

**OpenClaw user config** (deny built-in tools, enable plugin):
```yaml
tools:
  deny: [exec, bash, write, edit, apply_patch, message, sessions_send,
         browser, web_search, web_fetch, cron, canvas,
         nodes, gateway, image, tts]

plugins:
  entries:
    "@validance/safeclaw":
      enabled: true
      config:
        kernelUrl: "http://localhost:7400"
        trustProfile: "standard"
```

## 8. Constants Reference

| Constant | Value | File | Rationale |
|----------|-------|------|-----------|
| Pending entry expiry | 600,000ms (10 min) | `pending-store.ts` | GC window for abandoned proposals |
| Auto-approve race timeout | 500ms | `meta-tool.ts` | Catches server-side auto-approvals |
| Check tool poll timeout | 15,000ms (15s) | `approval-handler.ts` | Agent-side result polling |
| Resolver/sc-approve timeout | 30,000ms (30s) | `approval-handler.ts`, `index.ts` | User-initiated approval result wait |
| Webhook arrival wait | 3,000ms (3s) | `index.ts` | Delay in /sc-approve if webhook hasn't arrived |
| Client HTTP timeout | 300,000ms (5 min) | `kernel-client.ts` | Default constructor timeout |
| Health check timeout | 5,000ms (5s) | `kernel-client.ts` | `healthCheck()` abort signal |
| GET/DELETE timeout | 10,000ms (10s) | `kernel-client.ts` | Policy/session API calls |
| Gateway port | 18789 | `meta-tool.ts`, `openclaw.plugin.json` | Approval webhook callback |
| Default kernel URL | `http://localhost:7400` | `index.ts`, `openclaw.plugin.json` | Engine HTTP endpoint |
| Session hash prefix | `safeclaw:` | `session-map.ts` | Namespace isolation for SHA-256 |
| Session hash algorithm | SHA-256 | `session-map.ts` | Cryptographic hash for stable key derivation |
| globalThis key | `__safeclaw_pendingProposals__` | `pending-store.ts` | Singleton Map across module resolutions |

**Per-template timeouts and rate limits** — see the catalog table in [Section 3.2](#32-tool-catalog).

## 9. API Endpoints (Execution Engine)

SafeClaw communicates with the execution engine via these REST endpoints. The engine is pluggable — any HTTP service implementing this contract works.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/proposals` | Submit a tool proposal — blocks until approved + executed |
| `POST` | `/api/approvals/{id}/resolve` | Resolve a pending approval (approve/deny, optionally with remember) |
| `GET` | `/api/policies` | List learned policy rules (optional `?session_hash=` filter) |
| `DELETE` | `/api/policies/{id}` | Revoke a learned policy rule |
| `DELETE` | `/api/sessions/{hash}` | Cleanup session containers |
| `GET` | `/api/health` | Engine health check |

**Proposal request shape:**
```json
{
  "action": "exec",
  "parameters": { "command": "npm test" },
  "session_hash": "a1b2c3...",
  "mounts": [{"host_path": "/home/user/project", "container_path": "/workspace", "mode": "rw"}],
  "notify_url": "http://localhost:18789/safeclaw/approval-notify?proposalId=<uuid>"
}
```

**Proposal result shape:**
```json
{
  "status": "completed | failed | denied | rate_limited",
  "result": {
    "output": "...",
    "output_vars": {},
    "exit_code": 0,
    "error": null
  },
  "reason": null,
  "resource_usage": {},
  "duration_seconds": 1.23
}
```

## 10. Security Model

### What SafeClaw Guarantees

- **Volume isolation** — containers mount only the workspace directory (and `/home` read-only for exec). No access to host system files, other users' data, or the plugin process.
- **Approval gates** — human-confirm actions cannot execute without explicit user decision via `/sc-approve` or learned policy match.
- **Rate limiting** — per-session, per-action rate limits enforced by the execution engine. Prevents runaway tool loops.
- **Learned policies** — `allow-always`/`deny-always` create rules that persist to the database across sessions, reducing approval fatigue without removing control.
- **Non-root containers** — task containers run as `worker` (uid 1000) via the Dockerfile `USER` directive. The engine's proposal-pipeline mode respects this (no host bind-mounts overriding the user). `/etc/shadow` and other root-owned files are inaccessible inside containers.
- **Secret isolation** — secrets (API keys, credentials) are injected by the engine at execution time. They never pass through the plugin or the LLM.
- **Action exclusion** — always-deny actions are removed from the tool enum. The LLM cannot call them.
- **Deterministic approval** — `/sc-approve` is a plugin command, not a tool. The LLM cannot invoke it or influence the approval decision.

### What SafeClaw Does NOT Guarantee

See [risk-assessment.md](risk-assessment.md) for the full risk register. Key limitations:

- Pending store is unbounded (time-based GC only, no max size)
- In-memory state lost on gateway restart (pending proposals, session cache)
- No TLS on the webhook path (localhost assumed)
- Rate limits are per-session, not global
- No request signing between plugin and engine

### Trust Boundary

```
┌─────────────────────────────────────────────────────────┐
│  TRUSTED BOUNDARY (user's machine)                      │
│                                                         │
│  ┌───────────────┐     ┌────────────────────────┐       │
│  │ OpenClaw      │     │ Execution Engine       │       │
│  │ + SafeClaw    │◄───►│ (validates, executes)  │       │
│  │  plugin       │HTTP │                        │       │
│  └───────────────┘     └────────┬───────────────┘       │
│         │                       │                       │
│    /sc-approve             Docker API                   │
│    (user input)                 │                       │
│                        ┌────────┴────────┐              │
│                        │  Containers     │              │
│                        │  (isolated)     │              │
│                        └─────────────────┘              │
│                                                         │
│  LLM ──────────────────► safeclaw() tool only           │
│  (untrusted input)       (cannot call /sc-approve)      │
└─────────────────────────────────────────────────────────┘
```

The LLM is untrusted input. It can call `safeclaw()` and `safeclaw_check()` tools, but cannot issue `/sc-approve` commands, access the pending store directly, or bypass approval gates. The user controls all approval decisions through the deterministic command interface.

## 11. Host Filesystem Access Model

### Current State: Pure Isolation

Today, containers mount only engine-managed volumes (`/workspace`, `/home` read-only for exec). The host filesystem is never directly accessible. This provides strong isolation but limits usefulness — the agent cannot read or modify the user's actual project files.

### The Tension

Pure container isolation is safe but impractical for many real-world tasks: code editing, running tests against a local codebase, reading config files. Users who need host file access today must either (a) use OpenClaw's native tools (which SafeClaw denies) or (b) manually copy files into/out of containers.

This is the core product tension: **isolation guarantees safety; host access enables utility.** The solution must preserve SafeClaw's security model while providing controlled access to user-declared paths.

### Planned Approach: User-Declared Workspace Mounts

The design direction (not yet implemented) uses explicit, user-declared workspace mounts:

```yaml
# OpenClaw plugin config (future)
plugins:
  entries:
    "@validance/safeclaw":
      config:
        workspace:
          mounts:
            - host: "/home/user/project"
              container: "/workspace/project"
              mode: "ro"             # read-only by default
          never_mount:
            - "~/.ssh"
            - "~/.gnupg"
            - "~/.aws"
            - "**/node_modules"
            - "**/.env"
```

**Security layers (defense-in-depth):**

1. **User declaration** — only explicitly listed paths are mountable. No implicit host access.
2. **Never-mount list** — sensitive paths (credentials, keys, secrets) are excluded even if a parent is mounted. Ships with sensible defaults, user-extensible.
3. **Read-only default** — mounts are `ro` unless the user explicitly opts into `rw`.
4. **Approval escalation** — write-mode mounts on sensitive parent paths trigger `human-confirm` regardless of trust profile.
5. **Container isolation preserved** — mounts are bind-mounted into the existing container infrastructure. All other isolation guarantees (network policies, resource limits, approval gates) remain unchanged.

**What this does NOT do:**
- Grant containers access to arbitrary host paths
- Override the never-mount list programmatically
- Allow the LLM to request mounts — only the user declares them in config

This feature is tracked as future work and is **not a blocker for initial distribution**. See [risk-assessment.md § SA-013](risk-assessment.md) for the associated risks and [development-plan.md](development-plan.md) for status.
