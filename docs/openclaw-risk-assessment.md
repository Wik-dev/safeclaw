# OpenClaw — Comprehensive Risk Assessment

> **Project:** SafeClaw
> **Category:** Reference
> **Status:** Current
> **Date:** 2026-03-13

---

Original risk assessment of the OpenClaw codebase. SafeClaw's [risk-assessment.md](risk-assessment.md) § 5 maps these risks to mitigations.

**Date:** 2026-03-05
**Scope:** Full codebase analysis (security, architecture, operational)
**Branch:** main (commit 6bc982473)

## Project Overview

OpenClaw is a personal AI assistant gateway (Node.js/TypeScript) that connects to messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Matrix, etc.), routes messages to LLM providers (Anthropic, OpenAI, etc.), and executes tools on the user's behalf. It runs on user devices as a daemon (launchd/systemd).

---

## Critical Risks


| #   | Risk                                                              | Area         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                               | Affected Components                                                                      |
| --- | ----------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| C1  | **Prompt injection declared out of scope**                        | Security     | SECURITY.md explicitly marks prompt injection as "out of scope." Detection exists (`src/security/external-content.ts`) with 13+ regex patterns but is **logging-only -- never blocks**. External content is wrapped in XML markers with a security notice, but LLMs can be instructed to ignore these wrappers. Any inbound DM, group message, email, webhook, or web-fetched page can carry injection payloads that reach the LLM with full tool access. | `src/security/external-content.ts`, `src/gateway/chat-sanitize.ts`, all channel handlers |
| C2  | **Plugins run in-process with full OS privileges**                | Security     | Plugins/extensions execute in the same Node.js process as the gateway with **no sandbox, no capability restrictions, no isolation**. A malicious or compromised plugin has full filesystem, network, and process access. ClawHub skill supply chain uses only pattern-based moderation (regex) and GitHub account age checks -- no code signing, no VirusTotal scanning.                                                                                  | `src/channels/plugins/load.ts`, SECURITY.md lines 52-58                                  |
| C3  | **No message ingest rate limiting**                               | Availability | There is **no rate limiting on incoming messages from any channel**. An attacker can flood the bot via Telegram, WhatsApp, Discord, etc. causing CPU exhaustion, memory growth (unbounded draft buffers), and cascading LLM API cost. Gateway control-plane rate limiting (3 req/60s) exists but does not cover message ingest.                                                                                                                           | `src/channels/draft-stream-loop.ts`, all channel handlers                                |
| C4  | **Unofficial WhatsApp API (Baileys) -- ban and reliability risk** | Operational  | Uses `@whiskeysockets/baileys` 7.0.0-rc.9 (pre-release) which reverse-engineers WhatsApp Web. Meta actively blocks such usage. Credentials stored as plaintext JSON in `~/.openclaw/`. Account ban risk is real and well-documented. No fallback to official WhatsApp Business API.                                                                                                                                                                       | `src/whatsapp/`, `package.json`                                                          |
| C5  | **Arbitrary browser JavaScript execution**                        | Security     | Browser tool (`src/agents/tools/browser-tool.ts`) allows navigating URLs, clicking, typing, and **executing arbitrary JavaScript** in page context. Can access localStorage, cookies, session storage, form data. Combined with prompt injection (C1), an attacker could instruct the LLM to exfiltrate browser session data.                                                                                                                             | `src/agents/tools/browser-tool.ts`, `src/browser/`                                       |


---

## Major Risks


| #   | Risk                                               | Area         | Description                                                                                                                                                                                                                                                                                                           | Affected Components                                                                                                                               |
| --- | -------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Secrets stored in plaintext**                    | Security     | API keys (OpenAI, Anthropic, etc.) stored unencrypted in `~/.openclaw/auth-profiles.json`. Gateway tokens/passwords in `openclaw.json` or `.env`. Config audit log (`config-audit.jsonl`) captures diffs that may contain secrets. Config backups (10 rotations) retain old secrets unencrypted.                      | `~/.openclaw/auth-profiles.json`, `openclaw.json`, `src/config/io.ts`                                                                             |
| M2  | **PII sent to LLM providers without masking**      | Privacy      | Phone numbers, email addresses, Discord usernames, and group metadata flow directly to LLM APIs as part of conversation context. No built-in PII detection or automatic redaction before provider calls. GDPR/privacy implications for EU users.                                                                      | All channel handlers, agent runtime                                                                                                               |
| M3  | **Logging redaction is opt-in**                    | Security     | `logging.redactSensitive` defaults to "tools" mode (redacts only tool invocations). Secrets in message content, env vars, and config writes are **not redacted** unless explicitly configured. Verbose mode logs full request bodies.                                                                                 | `src/logging/redact.ts`, `src/logging/config.ts`                                                                                                  |
| M4  | **DNS rebinding not prevented in SSRF guard**      | Security     | SSRF protection (`src/infra/net/ssrf.ts`) is comprehensive for static IPs but resolves DNS only once. An attacker controlling a domain can return a public IP on first resolution, then rebind to 127.0.0.1 or metadata endpoints on the actual request. DNS pinning is optional, not default.                        | `src/infra/net/ssrf.ts`, `src/agents/tools/web-fetch.ts`                                                                                          |
| M5  | **Memory exhaustion via unbounded caches/buffers** | Availability | Multiple in-memory structures grow without bounds: web fetch cache (48h TTL, no max size), draft stream buffers (no max), auth rate limiter maps (per-IP, pruned but attackable), control-plane rate limiter (no visible pruning), session stores (no auto-TTL).                                                      | `src/agents/tools/web-fetch.ts`, `src/channels/draft-stream-loop.ts`, `src/gateway/auth-rate-limit.ts`, `src/gateway/control-plane-rate-limit.ts` |
| M6  | **Dockerfile pipe-to-shell pattern**               | Supply Chain | Bun installed via `curl -fsSL https://bun.sh/install | bash` with no SHA256 verification. Homebrew in sandbox-common uses similar pattern. If these URLs are compromised, arbitrary code executes during build.                                                                                                       | `Dockerfile` line 4, `Dockerfile.sandbox-common`                                                                                                  |
| M7  | **CI/CD actions not fully SHA-pinned**             | Supply Chain | Many GitHub Actions use tag refs (`actions/checkout@v4`) instead of pinned SHAs. Docker release has `provenance: false` (no SLSA attestation). Node.js version uses semver range `22.x` instead of exact pin. A compromised action tag could inject code into CI.                                                     | `.github/workflows/ci.yml`, `.github/workflows/docker-release.yml`                                                                                |
| M8  | **File system protection is opt-in**               | Security     | `tools.fs.workspaceOnly` and `tools.exec.applyPatch.workspaceOnly` default to **not enforced**. Path traversal protection in `src/infra/fs-safe.ts` is robust (symlink detection, inode matching, O_NOFOLLOW) but only applies when workspace restrictions are configured. Default installs have broader file access. | `src/infra/fs-safe.ts`, `src/agents/sandbox/fs-paths.ts`, SECURITY.md lines 66-70                                                                 |
| M9  | **Gateway password stored without hashing**        | Security     | Password auth mode stores and compares plaintext passwords (timing-safe, but no bcrypt/argon2 hashing or salting). If config file is leaked, password is immediately usable.                                                                                                                                          | `src/gateway/auth.ts`                                                                                                                             |
| M10 | **WebSocket origin validation gap**                | Security     | Origin check logic exists (`src/gateway/origin-check.ts`) but is not explicitly enforced before WebSocket connection acceptance in the connection handler. Legacy paired device metadata tolerance (PR #21447) could allow permission escalation for previously paired devices missing role/scope.                    | `src/gateway/server/ws-connection.ts`, `src/gateway/origin-check.ts`                                                                              |
| M11 | **No automatic migration rollback**                | Operational  | Config/state migrations run automatically on load. A buggy migration corrupts state with no automatic rollback. Session key canonicalization during migration can orphan sessions. Old config backups retained but recovery is manual.                                                                                | `src/config/legacy.migrations.ts`, `src/infra/state-migrations.ts`                                                                                |
| M12 | **Sandbox VNC unencrypted**                        | Security     | `Dockerfile.sandbox-browser` exposes VNC (port 5900) and noVNC (port 6080) in plaintext. If container ports are reachable on untrusted networks, browser session is fully visible.                                                                                                                                    | `Dockerfile.sandbox-browser`                                                                                                                      |


---

## Minor Risks


| #   | Risk                                               | Area                   | Description                                                                                                                                                                                                                                      | Affected Components                                 |
| --- | -------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| m1  | **`bind=auto` can fall back to 0.0.0.0**           | Configuration          | Default is safe (`loopback`), but `auto` mode binds to all interfaces if loopback is unavailable. No warning emitted when this fallback triggers, potentially exposing the gateway to LAN/internet.                                              | `src/config/types.gateway.ts`                       |
| m2  | **Express 5.x semver caret**                       | Dependency             | `express@^5.2.1` uses caret range on a pre-stable major version. Minor/patch updates could introduce breaking changes during the 5.x development cycle.                                                                                          | `package.json`                                      |
| m3  | **launchd KeepAlive without restart backoff**      | Operational            | macOS daemon uses `KeepAlive: true` with no delay, causing immediate restarts on crash. If the gateway crashes on startup (e.g., bad config), this creates a rapid restart loop consuming CPU. systemd is better configured with `RestartSec=5`. | `src/daemon/launchd.ts`                             |
| m4  | **Forced shutdown uses exit code 0**               | Operational            | When drain timeout expires, the gateway calls `exit(0)` even though shutdown was forced. Supervisors (systemd/launchd) cannot distinguish graceful from forced shutdown, complicating monitoring and alerting.                                   | `src/cli/gateway-cli/run-loop.ts` lines 54, 94, 108 |
| m5  | **Config audit log grows unbounded**               | Operational            | `config-audit.jsonl` captures all config write operations with diffs. No rotation policy is defined. Long-running instances accumulate large audit logs that may contain secrets from config changes.                                            | `src/config/io.ts`                                  |
| m6  | **iMessage accesses full system message database** | Privacy                | iMessage channel accesses `~/Library/Messages/chat.db` -- the user's **entire** message history, not just bot conversations. The database path is configurable but defaults to the system database.                                              | `src/imessage/`                                     |
| m7  | **No distributed lock for multi-machine**          | Operational            | Gateway lock file (`/tmp/openclaw-<uid>/gateway.lock`) only prevents concurrent local instances. No mechanism for multi-machine coordination if user runs multiple gateways pointing at the same state dir.                                      | `src/infra/gateway-lock.ts`                         |
| m8  | **pnpm minimumReleaseAge too aggressive**          | Supply Chain           | Set to 2880 minutes (2 days). A compromised npm package published and caught within 2 days could still be pulled. Industry recommendation is 7-14 days for critical infrastructure.                                                              | `package.json` line 216                             |
| m9  | **Source maps shipped in production dist**         | Information Disclosure | `dist/` includes source maps, exposing original TypeScript source code structure. Low risk for a self-hosted tool but could aid attackers analyzing the codebase for vulnerabilities.                                                            | Build pipeline, `package.json` files field          |
| m10 | **No systemd watchdog or health recovery**         | Operational            | systemd service uses `Type=simple` (fire-and-forget). No `WatchdogSec` or `Type=notify` for proactive health checking. Gateway health endpoint checks channel connectivity but doesn't verify agent execution or state integrity.                | `src/daemon/systemd.ts`                             |
| m11 | **Shell env extraction subprocess**                | Security               | `OPENCLAW_LOAD_SHELL_ENV=1` spawns a login shell subprocess to extract environment variables (15s timeout). On compromised systems, this could expose shell profile secrets or trigger unexpected shell initialization scripts.                  | `.env.example` lines 29-31                          |
| m12 | **SQLite no WAL mode documented**                  | Data Integrity         | Memory/embedding storage uses Node.js experimental `node:sqlite`. No documentation of WAL mode or journal protection. Concurrent writes (unlikely with lock file, but possible in edge cases) could corrupt the database.                        | `src/memory/sqlite.ts`                              |


---

## Risk Distribution Summary


| Severity     | Count | Top Concern                                                      |
| ------------ | ----- | ---------------------------------------------------------------- |
| **Critical** | 5     | Prompt injection + tool access, plugin trust, message flooding   |
| **Major**    | 12    | Plaintext secrets, PII exposure, supply chain, memory exhaustion |
| **Minor**    | 12    | Config edge cases, daemon management, dependency hygiene         |


---

## Methodology

Analysis performed via automated codebase exploration covering:

- Source code in `src/` (security, gateway, channels, plugins, agents, tools, infra, config, daemon, logging)
- Build and deployment files (Dockerfiles, CI workflows, package.json, scripts)
- Documentation (SECURITY.md, VISION.md, README.md, .env.example)
- Configuration schemas and default values
