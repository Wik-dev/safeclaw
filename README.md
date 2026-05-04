# SafeClaw

[OpenClaw](https://openclaw.ai/) plugin that lets you run OpenClaw on your everyday machine. Tool execution is routed to a [Validance](https://validance.io/) instance — local or remote — gated by human approval, learned policies, governance, and a data-integrity layer.

## Why this exists

OpenClaw's tool capabilities are extensive enough that operators occasionally provision a dedicated machine to host it. SafeClaw routes that execution off-host into an isolated environment, keeping OpenClaw on the operator's everyday machine without giving up tool capability.

With SafeClaw enabled in OpenClaw:

- Native tools (`exec`, `write`, `edit`, `browser`, `web_fetch`, `message`, …) are denied at the OpenClaw layer.
- One meta-tool (`safeclaw`) is registered. Every action that would have run locally goes through it.
- Action proposals are sent over HTTP to a Validance instance, which validates the request, applies learned policy, gates on human approval where required, executes in an isolated container, and records the run.
- Human-confirm actions surface in OpenClaw as inline `/sc-approve <id>` prompts.
- Trust profiles tune which actions auto-approve and which require confirmation.
- Gateway webhooks carry approval notifications from Validance back into OpenClaw.

The host machine never runs the LLM-supplied command. Approvals, policy, and execution all live on the Validance side.

## How it works

```
              YOUR MACHINE                              VALIDANCE INSTANCE
              ─────────────                             ──────────────────

  LLM agent
    │  calls safeclaw({ action, params })
    ▼
  @validance/safeclaw plugin
    │  native tools denied locally:
    │    exec, bash, write, edit, browser,
    │    web_fetch, message, ...
    │
    │  POST /api/proposals   ──HTTP(S)──▶  validate → apply policy
    │                                      gate human approval
    │  /sc-approve <id>      ◀──webhook──  pending approval (if needed)
    │  /sc-approve <id>      ──HTTP(S)──▶  resolve, execute in container
    │                        ◀──HTTP(S)──  result / [DENIED] / [RATE LIMITED]
    ▼
  OpenClaw shows the result
```

The LLM calls one tool (`safeclaw`) with an `action` parameter. The plugin denies OpenClaw's native execution tools, translates the call into a JSON proposal, and sends it to the configured Validance instance. The instance validates, applies policy, gates on approval where required, executes in isolation, and returns a structured result.

## What you need

- An [OpenClaw](https://openclaw.ai/) installation.
- A [Validance](https://validance.io/) instance — local or remote. The default `kernelUrl` (`https://api.validance.io`) is Validance's hosted evaluation endpoint, open for pre-GA use without authentication. For local installation or production access, see [Validance — Getting started](https://docs.validance.io/getting-started/).

## Quick start

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

For a local Validance instance, set `kernelUrl` to its address (typically `http://localhost:7400` or whatever you have configured).

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
| `kernelUrl` | `https://api.validance.io` | Validance instance URL (hosted evaluation by default; set to your own for local or production) |
| `trustProfile` | `standard` | Approval tier preset |
| `gatewayPort` | `18789` | OpenClaw gateway port (for approval webhooks; relevant when the Validance instance can reach the host) |
| `gatewayHost` | `localhost` | Host for webhook URL as seen from the Validance instance |

## Development

See [docs/architecture.md](docs/architecture.md) for plugin architecture, [docs/openclaw-risk-assessment.md](docs/openclaw-risk-assessment.md) for the OpenClaw security review SafeClaw maps mitigations to, and [docs/risk-assessment.md](docs/risk-assessment.md) for SafeClaw's own risk register.

```bash
npm install        # install dev dependencies
npm run build      # compile TypeScript
npm test           # run tests (vitest)
npm run lint       # type-check (tsc --noEmit)
```

Requires Node.js 18+ (native fetch). Zero external runtime dependencies.

## Roadmap

- **Now.** Manual install in OpenClaw. The default points at Validance's hosted evaluation endpoint; local or production Validance instances are documented at [docs.validance.io/getting-started](https://docs.validance.io/getting-started/).
- **Next.** `npx @validance/safeclaw start` — one command for the same install and config flow.
- **Later.** Bundled local mode — the same plugin will start a local Validance instance via Docker Compose. Gated on Validance's binary distribution.

The plugin contract, config keys, and approval flow stay stable across all three.

## License

MIT
