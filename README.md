# SafeClaw

Containerized tool execution for [OpenClaw](https://openclaw.ai/) via the [Validance](https://validance.io/) kernel.

SafeClaw is an OpenClaw plugin that reroutes dangerous tool calls (exec, write, browser, messaging) through Docker containers managed by Validance. The host is never touched.

## How it works

```
LLM Agent
  │  calls safeclaw({action: "exec", params: {command: "npm test"}})
  ▼
OpenClaw Plugin: @validance/safeclaw
  │  POST /api/proposals
  ▼
Validance Kernel
  │  catalog → rate-limit → learned-policy → approval-gate → secrets → worker
  ▼
Docker Container → result
```

The LLM calls one tool (`safeclaw`) with an `action` parameter. SafeClaw translates this into a structured proposal sent to the Validance kernel, which validates, gates, and executes it in an isolated container.

## Quick start

### 1. Start the Validance kernel

```bash
npx @validance/safeclaw start
```

This spins up the Validance kernel + PostgreSQL via Docker Compose (port 7400).

### 2. Install the plugin in OpenClaw

```bash
openclaw plugins install @validance/safeclaw
```

### 3. Configure OpenClaw

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
          "kernelUrl": "http://localhost:7400",
          "trustProfile": "standard"
        }
      }
    }
  }
}
```

Tools staying local (NOT denied): `read`, `sessions_list`, `sessions_history`, `session_status`, `agents_list`, `subagents`, `sessions_spawn`.

### 4. Use it

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
| `kernelUrl` | `http://localhost:7400` | Validance kernel HTTP URL |
| `trustProfile` | `standard` | Approval tier preset |
| `gatewayPort` | `18789` | OpenClaw gateway port (for approval webhooks) |
| `gatewayHost` | `localhost` | Host for webhook URL as seen from the Validance container |

## Development

See [docs/development.md](docs/development.md) for architecture details.

```bash
npm install        # install dev dependencies
npm run build      # compile TypeScript
npm test           # run tests (vitest)
npm run lint       # type-check (tsc --noEmit)
```

Requires Node.js 18+ (native fetch). Zero external runtime dependencies.

## License

MIT
