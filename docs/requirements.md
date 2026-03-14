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
| FR-004 | Load tool catalog from `catalog/default.json` at plugin registration                              | `catalog.ts`          | 15 templates, 4 Docker images                                       |
| FR-005 | Apply trust profile overrides to approval tiers                                                   | `catalog.ts`          | `conservative`, `standard`, `power-user`                            |
| FR-006 | Exclude `always-deny` actions from the tool's action enum                                         | `catalog.ts`          | LLM cannot call excluded actions (`gateway`)                        |
| FR-007 | Generate meta-tool description from catalog parameter schemas                                     | `catalog.ts`          | Per-action parameter documentation in tool description              |
| FR-008 | Map OpenClaw session keys to stable SHA-256 hashes                                                | `session-map.ts`      | `safeclaw:` prefix, cached for process lifetime                     |
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
| NFR-010 | Test suite passes                  | 28 tests (vitest)                      | kernel-client (4), catalog (5), meta-tool (5), approval (10), pending-store (4) |


## 3. Compatibility

### OpenClaw

- **Plugin API:** `register(api)` — uses `registerTool`, `registerHttpRoute`, `registerGatewayMethod`, `registerCommand`, `on` (events)
- **Workspace:** `api.config?.agent?.workspace` or `process.cwd()`
- **Session key:** `args._sessionKey` (opaque string, may be undefined)

### Execution Engine API

Any HTTP service implementing these endpoints is compatible:


| Endpoint                           | Required | Notes                                         |
| ---------------------------------- | -------- | --------------------------------------------- |
| `POST /api/proposals`              | Yes      | Core execution path — must block until result |
| `POST /api/approvals/{id}/resolve` | Yes      | Required for human-confirm flow               |
| `GET /api/policies`                | Optional | Learned policy management                     |
| `DELETE /api/policies/{id}`        | Optional | Learned policy revocation                     |
| `DELETE /api/sessions/{hash}`      | Optional | Session cleanup                               |
| `GET /api/health`                  | Optional | Health check on startup                       |


See [architecture.md § 9](architecture.md#9-api-endpoints-execution-engine) for full request/response schemas.

### Docker Images

The catalog references 4 Docker images. The execution engine must have access to:


| Image               | Tag      | Purpose                                                                        |
| ------------------- | -------- | ------------------------------------------------------------------------------ |
| `validance-sandbox` | `latest` | General-purpose execution (exec, write, edit, cron, image, tts, canvas, nodes) |
| `validance-browser` | `latest` | Headless browser automation                                                    |
| `validance-web`     | `latest` | HTTP fetch and search API                                                      |
| `validance-comms`   | `latest` | Email and messaging                                                            |


