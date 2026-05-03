# SafeClaw Stack — Responsibility Map

Three layers, strict separation. When something fails, this tells you where to look.

**OpenClaw documentation:** [docs.openclaw.ai](https://docs.openclaw.ai/) — [Channels](https://docs.openclaw.ai/channels) | [Tools](https://docs.openclaw.ai/tools) | [Plugins](https://docs.openclaw.ai/tools/plugin) | [Skills](https://docs.openclaw.ai/tools/skill)

---

## Layer 1: OpenClaw (AI assistant platform)

**What it owns:** Everything the user sees and touches — across all channels.

OpenClaw is a multi-channel AI assistant platform ([docs](https://docs.openclaw.ai/)). Telegram is one channel among many — see [Channels docs](https://docs.openclaw.ai/channels) for the full list (Discord, Slack, Signal, iMessage, WhatsApp, Teams, Matrix, TUI, etc.). The Telegram bot exists as a BotFather-registered bot with its own token, configured in OpenClaw's `channels.telegram` config section.

SafeClaw integrates as an OpenClaw **plugin** ([plugin docs](https://docs.openclaw.ai/tools/plugin)) — it registers tools and commands via the plugin API. OpenClaw handles the rest (channels, LLM, conversation, UI). See [Tools docs](https://docs.openclaw.ai/tools) for how OpenClaw manages tool registration, profiles, and deny/allow lists.

| Responsibility | Details |
|---|---|
| Channel adapters | Telegram (Grammy, bot token via BotFather), Discord, Slack, Signal, TUI, etc. Each channel has its own config section and adapter code |
| LLM conversation | Claude/model API calls, system prompt, tool definitions, chat history |
| Intent extraction | Parsing natural language into structured tool calls (LLM decides which tool to call) |
| Multi-tool-call handling | Collecting multiple `tool_use` blocks from LLM response, dispatching each |
| Plugin loading | Discovering, loading, and registering plugins (including SafeClaw) via `register(api)` |
| Tool registry | Merging plugin-provided tools (like `safeclaw`) with built-in tools |
| Approval UX | Displaying approval prompts to the user; channel-specific UI (inline buttons on Telegram, text commands on TUI) |
| Result rendering | Channel-specific formatting (Telegram HTML, Discord markdown, TUI plain text) |
| Gateway | HTTP server (port 19001) for webhooks, plugin routes, health checks |
| Session identity | Providing `sessionKey` / `agentId` to plugins (channel-independent) |
| `tools.deny` / `tools.alsoAllow` | Blocking built-in tools when SafeClaw replaces them; allowing plugin tools alongside a profile |
| Error display | Surfacing errors from plugins/tools to the user in channel-appropriate format |

**Telegram-specific notes:**
- Bot created via BotFather on Telegram, has its own token
- Token stored in OpenClaw config: `channels.telegram.botToken`
- Grammy library handles polling, message parsing, inline keyboards
- Gateway bind must be `lan` (not `loopback`) for containers to reach webhooks

**Failure modes at this layer:**
- LLM API down or rate-limited → assistant unresponsive
- Bad tool description → LLM calls wrong action or wrong params
- Channel adapter error → messages not delivered (Telegram API down, bot token revoked, etc.)
- Plugin not loaded → SafeClaw tool not available to LLM
- Gateway unreachable from containers → approval webhooks never arrive
- `tools.alsoAllow` missing `safeclaw` → plugin tool registered but not exposed to LLM

---

## Layer 2: SafeClaw (plugin / integration bridge)

**What it owns:** Bridging OpenClaw's plugin API to Validance's REST API. Channel-agnostic — works identically across Telegram, Discord, TUI, etc.

| Responsibility | Details |
|---|---|
| Meta-tool registration | `safeclaw({action, params})` — single LLM-callable tool wrapping all 15+ actions |
| `safeclaw_check` tool | Polling tool for pending approval status |
| HTTP client to Validance | `POST /api/proposals`, `GET /api/health`, `GET /api/audit/{entity_id}`, `GET /api/policies` |
| Proposal construction | Mapping LLM tool call → `{action, parameters, session_hash, approval_tier_override}` |
| Session hash derivation | `SHA256("safeclaw:" + sessionKey)` — channel-independent, derived from OpenClaw's session key |
| Catalog loading | Reading `catalog/default.json` at registration, generating LLM tool descriptions via `buildDescription()` |
| Trust profiles | Conservative / standard / power-user tier overlays — relax approval tiers per profile (never tighten) |
| Approval webhook handler | HTTP route `/safeclaw/approval-notify` — receives `approval_id` from Validance, links to pending proposal |
| Approval lifecycle | Linking webhook `approval_id` to pending store entry, resolving via user command or gateway method |
| `/sc-approve` command | Deterministic approval: `allow-once`, `allow-always`, `deny`, `deny-always` (no LLM involvement) |
| `/sc-policies` command | List and revoke learned policy rules |
| `safeclaw.approval.resolve` | Gateway method for UI-driven approval (non-command path) |
| Result formatting | Formatting Validance execution results for LLM consumption |
| Health check | Verifying Validance API reachability on plugin start |
| Docker Compose packaging | `npx @validance/safeclaw start` — Validance + PostgreSQL for end-user deploy (future) |

**Failure modes at this layer:**
- Validance unreachable → HTTP timeout, proposal never executes
- Webhook not received → approval prompt never appears, proposal times out (300s) → denied
- Wrong action mapping → Validance rejects with "unknown action" (HTTP 400)
- Wrong param schema → Validance rejects with validation error (HTTP 400)
- `session_hash` not consistent → learned policies don't match, audit trail not correlated
- Approval resolved too late → Validance already timed out → denied
- Stale catalog → plugin offers actions that don't exist in Validance

---

## Layer 3: Validance (execution engine)

**What it owns:** Validated, containerized execution. Generic — knows nothing about OpenClaw, SafeClaw, Telegram, or any specific caller.

| Responsibility | Details |
|---|---|
| Template Catalog | Loading `catalog.json`, validating proposals against parameter schemas |
| Approval Gate | Creating approval records, polling for resolution, timeout (300s) → deny |
| Learned Policy | Persisting rules from "approve + remember" to PostgreSQL, matching future proposals, TTL/expiry |
| Policy Ceilings | Actions/sub-types that bypass learned rules — always require approval gate regardless of prior allow rules |
| Secret Store | Resolving `secret_refs` via backends (currently `EnvironmentBackend`), injecting as container env vars. Fail-closed: unresolved secret → proposal rejected before container starts |
| Container execution | Docker image management, container spawn, command execution, stdout/stderr capture, resource tracking |
| Persistent Worker | Keeping containers alive across proposals within a session. Pool keyed by `session_hash:docker_image` |
| Worker routing | `persistent: true` → reuse from pool; `persistent: false` → one-shot container |
| Audit trail | Hash-chained, tamper-evident event log. Event types: `workflow.started`, `workflow.status_changed`, `task.started`, `task.status_changed`, `task.completed`, `task.budget_exceeded`, `action.approval_requested`, `action.approved`, `action.denied`, `action.timeout`, `policy.rule_created`, `policy.rule_revoked`, `file.created`, `variable.set` |
| Rate limiting | Per-session, per-template, per-window (default 3600s). In-memory — resets on API restart |
| Budget enforcement | Task-level token/cost limits. Emits `task.budget_exceeded` audit event, marks task as FAILED |
| Volume mounts | `${WORKSPACE}` and `${HOME}` resolution in catalog volume specs. `/work` = shared writable directory (always mounted) |
| Network policy | Per-template egress allow/deny (defined in catalog schema, **not yet enforced**) |
| Webhook notification | POST to `notify_url` when approval is needed (caller provides URL in proposal) |
| Container cleanup | Persistent worker reaper (idle timeout), session cleanup on `DELETE /api/sessions/{hash}` |
| Database | PostgreSQL — workflow/task execution records, audit events, approval records, learned-policy rules |

**API endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/proposals` | Submit a tool proposal for validation + execution |
| POST | `/api/approvals/{approval_id}/resolve` | Approve or deny a pending proposal |
| GET | `/api/policies` | List learned policy rules (optional `?session_hash=` filter) |
| DELETE | `/api/policies/{rule_id}` | Revoke a learned policy rule |
| GET | `/api/health` | Health check (API, database, storage) |
| GET | `/api/audit/{entity_id}` | Audit events for an entity |
| GET | `/api/audit/{entity_id}/verify` | Verify audit hash chain integrity |
| GET | `/api/audit/stats` | Audit statistics |
| DELETE | `/api/sessions/{session_hash}` | Cleanup session (persistent workers, policies) |

**Failure modes at this layer:**
- Docker daemon down → container execution fails
- Database unreachable → all state operations fail, audit breaks
- Secret not found → `SecretResolutionError`, proposal rejected before container starts
- Image not pulled/built → container can't start
- Rate limit exceeded → proposal rejected (working as designed)
- Approval timeout → denied (fail-closed by design)
- Audit write failure → execution halts (fail-closed)
- Global audit chain break under concurrency (known issue with `--workers > 1`)
- Persistent worker container crash → `TaskResult` with error returned
- Volume mount misconfigured → container can't read/write expected paths

---

## Cross-Layer Failure Modes

Symptoms that appear at one layer but originate at another.

| Symptom | Appears at | Actual cause |
|---|---|---|
| "Action failed: unknown error" | Layer 1 (user sees error) | Container script crashed (Layer 3) or bad param mapping (Layer 2) |
| Approval buttons never appear | Layer 1 (no prompt shown) | Webhook not reachable — gateway bound to loopback, container can't reach it (Layer 1 config) or `notify_url` wrong (Layer 2) |
| Proposal hangs then denied after 5 min | Layer 1 (timeout message) | Webhook never arrived (Layer 2) or user never saw approval prompt (Layer 1) |
| Correct action, wrong result | Layer 1 (unexpected output) | Volume mount wrong — container wrote to ephemeral path, not `/work` (Layer 3) |
| "Rate limit exceeded" unexpectedly | Layer 1 (error message) | Different conversations sharing same `session_hash` (Layer 2 hash collision) |
| Audit trail shows gaps | Layer 1 (incomplete audit) | Concurrent workers broke global chain (Layer 3, known issue) |
| Learned policy not applying | Layer 1 (still prompting) | `session_hash` changed between proposals — different OpenClaw session key (Layer 2) |
| Action works in curl but not via agent | Layer 1 (agent fails) | `tools.alsoAllow` missing `safeclaw` (Layer 1 config) or trust profile blocks tier (Layer 2) |
| "Secret could not be resolved" | Layer 1 (error message) | API key not set in Validance process env (Layer 3 config) |
| Gateway-proxy action fails | Layer 1 (connection error) | OpenClaw gateway not running or `host.docker.internal` not resolvable from container (Layer 1 + Layer 3 networking) |

---

## Decision Guide: Where to Fix What

| Problem type | Fix at |
|---|---|
| UX, formatting, message rendering | Layer 1 (OpenClaw channel adapter) |
| LLM behavior, tool descriptions, intent parsing | Layer 1 (OpenClaw) + Layer 2 (catalog descriptions) |
| Bot token, channel config, gateway bind | Layer 1 (OpenClaw config) |
| HTTP errors, webhook delivery, action mapping | Layer 2 (SafeClaw connector) |
| Approval flow timing, pending store | Layer 2 (SafeClaw) |
| Trust profile adjustments | Layer 2 (SafeClaw `trust-profiles.ts`) |
| Execution correctness, container behavior | Layer 3 (Validance connector scripts) |
| Security (catalog, secrets, audit, rate limits) | Layer 3 (Validance kernel) |
| Capability gaps vs native OpenClaw | Layer 3 (Validance) — missing template, wrong image, missing volume |
| Performance (container startup, worker pool) | Layer 3 (Validance) |
| Cross-channel consistency | Layer 2 (SafeClaw) — session hash is channel-independent by design |
