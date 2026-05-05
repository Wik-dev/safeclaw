# SafeClaw

Source: [github.com/Wik-dev/safeclaw](https://github.com/Wik-dev/safeclaw)

[OpenClaw](https://openclaw.ai/) plugin that makes it safe to run OpenClaw on your everyday machine. Tool execution is routed to a [Validance](https://docs.validance.io/) instance (or any server that implements the contract) — gated by human approval, learned policies, and governance; recorded in a tamper-evident audit chain.

## Why this exists

SafeClaw adds safety, governance, and audit to an OpenClaw deployment: every action that would otherwise execute with OpenClaw's privileges is gated by human approval and learned policy, runs in an isolated container, and is recorded in a tamper-evident audit chain.

With SafeClaw enabled in OpenClaw:

- Native tools are denied via the OpenClaw config (see Quick start, step 2).
- SafeClaw re-exposes those capabilities as tools that route through Validance.
- Human-confirm actions surface in OpenClaw as inline `/sc-approve <id>` prompts.
- Trust profiles tune which actions auto-approve and which require confirmation.
- Gateway webhooks carry approval notifications from Validance back into OpenClaw.

## How it works

![SafeClaw request flow between the host machine and a Validance instance](docs/safeclaw_request_flow.svg)

## What you need

- An [OpenClaw](https://openclaw.ai/) installation.
- A [Validance](https://docs.validance.io/) instance — local or remote. The default `kernelUrl` (`https://api.validance.io`) is Validance's hosted evaluation endpoint, open for pre-GA use without authentication. For local installation or production access, see [Validance — Getting started](https://docs.validance.io/getting-started/).

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
| `catalogOverlayPath` | *(unset)* | Absolute path to a catalog overlay JSON file. Templates in the overlay are merged into the bundled default catalog; overlay wins on key collision. Falls back to the `SAFECLAW_CATALOG_OVERLAY` env var if unset. |

## Adding your own tools (catalog overlay)

The bundled `catalog/default.json` ships the 16 OpenClaw-native tool replacements. To add deployment-specific tools — vertical extensions, operational endpoints, custom workflows — supply an **overlay file** at deployment time. Your overlay lives outside the npm package; the published plugin stays clean.

**1. Author the overlay** (any absolute path on the host):

```jsonc
// /etc/safeclaw/local-overlay.json
{
  "templates": {
    "my_tool": {
      "description": "What this tool does (used in the LLM tool description)",
      "docker_image": "my-image",
      "command_template": "python /project/scripts/my_tool.py",
      "parameter_schema": {
        "type": "object",
        "properties": {
          "input": { "type": "string", "description": "Input value" }
        },
        "required": ["input"]
      },
      "approval_tier": "human-confirm",
      "timeout": 60,
      "rate_limit": 50,
      "tier_overrides": {
        "power-user": "auto-approve"
      }
    }
  },
  "images": {
    "my-image": "registry.example.com/my-image:latest"
  }
}
```

**2. Wire it into the plugin** — choose one:

- *Plugin config* — add `"catalogOverlayPath": "/etc/safeclaw/local-overlay.json"` to the `config` block in your OpenClaw config.
- *Environment variable* — `export SAFECLAW_CATALOG_OVERLAY=/etc/safeclaw/local-overlay.json` before starting the OpenClaw gateway.

**3. Restart the OpenClaw gateway.**

The corresponding template must also be registered on your Validance instance (image built and available, parameter schema understood). Overlay entries that the kernel doesn't recognize will fail at proposal time with "unknown action."

`tier_overrides` lets your overlay declare its own per-profile semantics. Conservative-profile users see `human-confirm`; power-user-profile users see whatever you mapped (e.g. `auto-approve` for read-only queries). The blanket `TRUST_OVERRIDES` table in `src/catalog.ts` is bypassed for entries that supply their own.

Overlay entries can also override existing default entries — e.g. tighten a default tool's `rate_limit` for your deployment by re-declaring the template under the same key. Overlay wins on collision.

## Development

See [docs/architecture.md](docs/architecture.md) for plugin architecture, [docs/openclaw-risk-assessment.md](docs/openclaw-risk-assessment.md) for the OpenClaw security review SafeClaw maps mitigations to, and [docs/risk-assessment.md](docs/risk-assessment.md) for SafeClaw's own risk register.

```bash
npm install        # install dev dependencies
npm run build      # compile TypeScript
npm test           # run tests (vitest)
npm run lint       # type-check (tsc --noEmit)
```

Requires Node.js 18+ (native fetch). Zero external runtime dependencies.

## License

MIT
