# SafeClaw — Requirements

> **Audience:** Contributors, security reviewers, plugin registry maintainers.

---

**Related documents:** [architecture.md](architecture.md) · [risk-assessment.md](risk-assessment.md) · [validance-integration.md](validance-integration.md)

## 1. Functional Requirements


| ID     | Requirement                                                                                       | Component             | Notes                                                               |
| ------ | ------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------- |
| FR-001 | Deny built-in dangerous tools via OpenClaw `tools.deny` config and register replacement meta-tool | `index.ts`            | 16 tools denied; see `DENIED_TOOLS` in `trust-profiles.ts`          |
| FR-002 | Register a single `safeclaw` meta-tool accepting `{action, params}`                               | `meta-tool.ts`        | LLM calls one tool; action enum is catalog-driven                   |
| FR-003 | Register a `safeclaw_check` tool for polling pending action results                               | `approval-handler.ts` | Agent calls after approval to retrieve output                       |
| FR-004 | Load tool catalog from `catalog/default.json` at plugin registration                              | `catalog.ts`          | 16 templates, 4 Docker images                                       |
| FR-005 | Apply trust profile overrides to approval tiers                                                   | `catalog.ts`          | `conservative`, `standard`, `power-user`                            |
| FR-006 | Exclude `always-deny` actions from the tool's action enum                                         | `catalog.ts`          | LLM cannot call excluded actions (`gateway`)                        |
| FR-007 | Generate meta-tool description from catalog parameter schemas                                     | `catalog.ts`          | Per-action parameter documentation in tool description              |
| FR-008 | Derive session identity from channel-independent agent ID (not channel-specific session key)       | `session-map.ts`      | `safeclaw:` prefix + `agentId`, SHA-256, cached for process lifetime |
| FR-009 | Auto-approve path: blocking HTTP call with abort signal passthrough                               | `meta-tool.ts`        | Single round-trip for auto-approve tier actions                     |
| FR-010 | Human-confirm path: background promise with 500ms race check                                      | `meta-tool.ts`        | Catches server-side auto-approvals (learned policy)                 |
| FR-011 | Store pending proposals in memory keyed by UUID                                                   | `pending-store.ts`    | Links agent-side proposalId to engine-side approvalId               |
| FR-012 | Garbage-collect pending entries older than 10 minutes                                             | `pending-store.ts`    | Triggered on each human-confirm call and check tool call            |
| FR-013 | Receive approval webhook from engine at `/safeclaw/approval-notify`                               | `approval-handler.ts` | Extract proposalId from `?proposalId=` query param                  |
| FR-014 | Link engine `approval_id` to agent-side `proposalId` via webhook                                  | `approval-handler.ts` | Mutates pending store entry                                         |
| FR-015 | Provide `/sc-approve` deterministic command                                                       | `index.ts`            | Four decisions: `allow-once`, `allow-always`, `deny`, `deny-always` |
| FR-016 | `/sc-approve` waits up to 30s for execution result after approval                                 | `index.ts`            | Returns result or timeout message                                   |
| FR-017 | `/sc-approve` waits 3s for webhook if `approvalId` not yet linked                                 | `index.ts`            | Handles race between command and webhook arrival                    |
| FR-018 | `allow-always`/`deny-always` send `remember: true` to engine                                      | `index.ts`            | Creates learned policy rule in engine                               |
| FR-019 | Provide gateway method `safeclaw.approval.resolve`                                                | `approval-handler.ts` | UI-driven approval (accepts approval_id or proposal_id)             |
| FR-020 | Resolver waits up to 30s for execution result                                                     | `approval-handler.ts` | Same timeout as `/sc-approve`                                       |
| FR-021 | `safeclaw_check` waits up to 15s for result                                                       | `approval-handler.ts` | Returns result, error, or "still waiting" with re-prompt            |
| FR-022 | Health check on `gateway_start` event                                                             | `index.ts`            | Logs reachability status of execution engine                        |
| FR-023 | Session cleanup on `gateway_stop` event                                                           | `index.ts`            | Best-effort `DELETE /api/sessions/all`                              |
| FR-024 | Format execution results for LLM consumption                                                      | `meta-tool.ts`        | Status-specific formatting: completed, failed, denied, rate_limited |
| FR-025 | Register HTTP route for approval webhook                                                          | `index.ts`            | `POST /safeclaw/approval-notify` with plugin auth                   |
| FR-026 | `/sc-policies` lists all active learned rules (action, scope, match pattern, age)                 | `index.ts`            | Calls `GET /api/policies`; formats as readable table                |
| FR-027 | `/sc-policies revoke <rule_id>` deletes a rule, restoring default approval behavior               | `index.ts`            | Calls `DELETE /api/policies/{id}`                                   |
| FR-028 | Learned rules persist across conversations (belong to user, not conversation)                     | Engine contract       | Rules stored server-side; survive plugin/agent restarts             |
| FR-029 | Learned rules apply across all channels (Telegram, Discord, TUI, etc.)                            | `session-map.ts`      | Session hash derived from `agentId` (channel-independent)           |


## 2. Non-Functional Requirements


| ID      | Requirement                        | Target                                 | Notes                                                                           |
| ------- | ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| NFR-001 | Zero external runtime dependencies | 0 npm packages at runtime              | `fetch`, `crypto`, `fs`, `path`, `http` from Node.js built-ins only             |
| NFR-002 | Node.js 18+ required               | `engines.node >= 18.0.0`               | Native `fetch` API required                                                     |
| NFR-003 | TypeScript strict mode             | `"strict": true`                       | ES2022 target, ES2022 module                                                    |
| NFR-004 | Auto-approve round-trip latency    | < 1s perceived                         | Blocking HTTP call; engine-side execution adds variable time                    |
| NFR-005 | Human-confirm prompt latency       | < 500ms                                | Background fire + pending store write + return prompt                           |
| NFR-006 | Plugin load time                   | < 100ms                                | Synchronous catalog file read + trust profile application                       |
| NFR-007 | Pending store bounded by GC        | 10-minute TTL                          | No max entry count — time-based GC only (see [SA-003](risk-assessment.md))      |
| NFR-008 | Build output                       | `dist/` directory, CommonJS-compatible | `tsc` produces `.js` + `.d.ts`                                                  |
| NFR-009 | Package distributable via npm      | `npm pack` / `npm publish`             | `files: [dist/, catalog/, docker/, bin/]`                                       |
| NFR-010 | Test suite passes                  | 138+ tests (vitest)                    | See `tests/` directory (unit + integration)                                     |


## 3. Host Filesystem Access (Future)

Requirements for the planned workspace mount feature. **Not implemented — not a blocker for v0.1.0 distribution.**

| ID      | Requirement                                                                                       | Priority | Notes                                                                         |
| ------- | ------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| FR-030  | User-declared workspace mounts via plugin config (`workspace.mounts[]`)                           | Must     | Only explicitly listed host paths are mountable into containers                |
| FR-031  | Never-mount list (`workspace.never_mount[]`) with sensible defaults                               | Must     | `~/.ssh`, `~/.gnupg`, `~/.aws`, `**/.env`, `**/node_modules` etc.            |
| FR-032  | Read-only mount by default; write requires explicit `mode: "rw"` in config                        | Must     | Defense-in-depth: accidental write exposure prevented at config level          |
| FR-033  | Never-mount list takes precedence over mounts (even if parent is mounted)                         | Must     | `.ssh` excluded even if `~` is mounted                                        |
| FR-034  | Approval escalation for write-mode mounts on sensitive parent paths                               | Should   | `human-confirm` tier override regardless of trust profile                     |
| FR-035  | LLM cannot request or modify mount configuration                                                  | Must     | Mounts are user-declared in config only, never agent-controlled               |
| NFR-011 | Workspace mount feature must not weaken existing container isolation guarantees                    | Must     | Network policies, resource limits, approval gates unchanged                   |


## 4. Compatibility

### OpenClaw

- **Plugin API:** `register(api)` — uses `registerTool`, `registerHttpRoute`, `registerGatewayMethod`, `registerCommand`, `on` (events)
- **Workspace:** `api.config?.agent?.workspace` or `process.cwd()`
- **Session identity:** Derived from `args._agentId` (channel-independent, stable per user). Falls back to `args._sessionKey` if `_agentId` unavailable. Ensures learned policies apply across all channels (Telegram, Discord, TUI, etc.).

### Execution Engine API

Any HTTP service implementing these endpoints is compatible:


| Endpoint                           | Required | Notes                                         |
| ---------------------------------- | -------- | --------------------------------------------- |
| `POST /api/proposals`              | Yes      | Core execution path — must block until result |
| `POST /api/approvals/{id}/resolve` | Yes      | Required for human-confirm flow               |
| `GET /api/policies`                | Yes      | Learned policy management (FR-026)            |
| `DELETE /api/policies/{id}`        | Yes      | Learned policy revocation (FR-027)            |
| `DELETE /api/sessions/{hash}`      | Optional | Session cleanup                               |
| `GET /api/health`                  | Optional | Health check on startup                       |


See [architecture.md § 9](architecture.md#9-api-endpoints-execution-engine) for full request/response schemas.

### Docker Images

The catalog references 4 Docker images. The execution engine must have access to:


| Image               | Tag      | Purpose                                                                        |
| ------------------- | -------- | ------------------------------------------------------------------------------ |
| `validance-sandbox` | `latest` | General-purpose execution (exec, write, edit, apply_patch, cron, process, image, tts) |
| `validance-browser` | `latest` | Headless browser automation                                                    |
| `validance-web`     | `latest` | HTTP fetch and search API                                                      |
| `validance-comms`   | `latest` | Email, messaging, canvas, and nodes (gateway proxy)                            |


