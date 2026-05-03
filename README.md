# SafeClaw

**[OpenClaw](https://openclaw.ai/) plugin that makes the assistant safe to install on your laptop.** SafeClaw denies the native dangerous tools (exec, write, browser, messaging) and reroutes them through a remote execution kernel over HTTP — the host stays clean; approvals and policy live server-side.

## Why this exists

OpenClaw is a powerful personal AI assistant — but its current threat model has [known critical risks](docs/openclaw-risk-assessment.md): prompt injection is out of scope, plugins run in-process with full OS privileges, the browser tool executes arbitrary JavaScript, message ingest has no rate limit, and more. Many users today work around this by buying a separate machine just to run OpenClaw safely.

SafeClaw's goal is to remove that workaround: keep OpenClaw on your real laptop, without giving up tool capability.

With SafeClaw enabled in OpenClaw:

- **Native dangerous tools are denied** at the OpenClaw layer (one config block).
- **One meta-tool (`safeclaw`) is registered** — every potentially-risky action goes through it.
- **Risky actions are routed over HTTP** to a remote execution kernel that runs them in isolated containers.
- **Human-confirm actions surface as inline `/sc-approve <id>` prompts** in OpenClaw.
- **Trust profiles** tune what auto-approves vs needs confirmation.
- **Gateway webhooks** carry approval notifications from the kernel back into OpenClaw.

The host machine never runs the LLM-supplied command. Approvals, policy, and execution live remote.

## How it works

```
                YOUR LAPTOP                                  REMOTE KERNEL
                ─────────────                                ──────────────

   LLM agent
     │  calls safeclaw({ action, params })
     ▼
   @validance/safeclaw
     │  native dangerous tools denied locally:
     │    exec, bash, write, edit, browser,
     │    web_fetch, message, ...
     │
     │  POST /api/proposals   ───HTTPS───▶    validate → policy → approval gate
     │                                        execute in isolated container
     │  /sc-approve <id>      ◀──webhook────  pending approval? (if human-confirm)
     │  /sc-approve <id>      ───HTTPS───▶    resolve approval
     │                        ◀──HTTPS─────   result / [DENIED] / [RATE LIMITED]
     ▼
   LLM sees the result
```

The LLM calls one tool (`safeclaw`) with an `action` parameter. The plugin denies OpenClaw's native dangerous tools, translates the call into a JSON proposal, and sends it to the kernel. The kernel validates, applies policy, gates on human approval where required, executes in isolation, and returns a structured result.

## The execution kernel

SafeClaw is **kernel-shaped**, not Validance-locked. The plugin issues HTTP `POST /api/proposals` against `kernelUrl` and interprets a small JSON response contract — that's what an alternate kernel would need to implement.

The reference kernel — and the supported path today — is **[Validance](https://validance.io)**, hosted at `https://api.validance.io` and open for pre-GA evaluation. It fully implements the contract (proposals, approvals, learned policies, audit chain) and is what every default in this README points at.

## Quick start

> **Pre-GA evaluation.** Validance is hosted at `https://api.validance.io` and is open for evaluation — no auth required. This is the default `kernelUrl` for SafeClaw out of the box.

### 1. Install the plugin in OpenClaw

```bash
openclaw plugins install @validance/safeclaw
```

(Or `openclaw plugins install npm:@validance/safeclaw` to force resolution via npm.)

### 2. Configure OpenClaw

Add to your OpenClaw config:

```json
{
  "tools": {
    "deny": ["exec", "bash", "write", "edit", "apply_patch", "message",
             "sessions_send", "browser", "web_search", "web_fetch",
             "cron", "canvas", "nodes", "gateway", "image", "tts"]
  },
  "plugins": {
    "entries": {
      "@validance/safeclaw": {
        "enabled": true,
        "config": {
          "kernelUrl": "https://api.validance.io",
          "trustProfile": "standard"
        }
      }
    }
  }
}
```

Tools staying local (NOT denied): `read`, `sessions_list`, `sessions_history`, `session_status`, `agents_list`, `subagents`, `sessions_spawn`.

### 3. Use it

```bash
openclaw tui
# or
openclaw agent --message "List files in /tmp"
```

Actions requiring approval show an inline prompt:

```
Action requires approval: exec
To approve: /sc-approve <id> allow-once
To always approve this pattern: /sc-approve <id> allow-always
To deny: /sc-approve <id> deny
```

## Trust profiles

| Profile | Behavior |
|---------|----------|
| `conservative` | Everything requires human confirmation |
| `standard` (default) | exec/browser/message/cron require confirmation; file/web/media auto-approve |
| `power-user` | exec/browser also auto-approve |

## Plugin config

| Option | Default | Description |
|--------|---------|-------------|
| `kernelUrl` | `https://api.validance.io` | Validance kernel HTTP URL (hosted, pre-GA evaluation) |
| `trustProfile` | `standard` | Approval tier preset |
| `gatewayPort` | `18789` | OpenClaw gateway port (for approval webhooks; advanced/local-only) |
| `gatewayHost` | `localhost` | Host for webhook URL as seen from the Validance container |

## Development

See [docs/architecture.md](docs/architecture.md) for plugin architecture and [docs/risk-assessment.md](docs/risk-assessment.md) for the security risk register.

```bash
npm install        # install dev dependencies
npm run build      # compile TypeScript
npm test           # run tests (vitest)
npm run lint       # type-check (tsc --noEmit)
```

Requires Node.js 18+ (native fetch). Zero external runtime dependencies.

## Roadmap

- **Now.** Plugin installs into OpenClaw and uses hosted Validance at `https://api.validance.io` (pre-GA evaluation, no auth).
- **Next.** Scripted bootstrap — `npx @validance/safeclaw start` will automate the install and config above into one command.
- **Later.** Self-hosted Validance — same plugin will support a local mode bundling Validance via Docker Compose. Gated on the binary distribution track.

Each step builds on the previous one. The plugin contract, config keys, and approval flow stay stable across all three.

## License

MIT
