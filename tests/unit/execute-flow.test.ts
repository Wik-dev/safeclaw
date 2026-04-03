/**
 * Cross-module wiring tests for the meta-tool execute() flow.
 *
 * These test how modules compose at runtime — session-map, pending-store,
 * catalog, formatResult — all wired through execute(). KernelClient is
 * mocked (no HTTP), everything else runs for real.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createSafeClawTool, type SafeClawConfig } from "../../src/meta-tool.js";
import { Catalog, type CatalogData } from "../../src/catalog.js";
import { KernelClient } from "../../src/kernel-client.js";
import { pendingProposals } from "../../src/pending-store.js";
import { sessionHash, clearSessionCache } from "../../src/session-map.js";

// --- Fixtures ---

const AUTO_CATALOG: CatalogData = {
  templates: {
    exec: {
      approval_tier: "auto-approve",
      parameter_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  images: {},
};

const CONFIRM_CATALOG: CatalogData = {
  templates: {
    exec: {
      approval_tier: "human-confirm",
      parameter_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  images: {},
};

const DEFAULT_CONFIG: SafeClawConfig = {
  kernelUrl: "http://localhost:7400",
};

let client: KernelClient;

beforeEach(() => {
  client = new KernelClient("http://localhost:7400");
  clearSessionCache();
});

afterEach(() => {
  pendingProposals.clear();
  vi.restoreAllMocks();
});

// --- session_hash derivation ---

describe("execute() session_hash", () => {
  it("derives session_hash from _sessionKey", async () => {
    const spy = vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: { output: "ok", output_vars: {} },
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    await tool.execute("c1", {
      action: "exec",
      params: { command: "ls" },
      _sessionKey: "user-session-42",
    } as any);

    expect(spy.mock.calls[0][0].session_hash).toBe(
      sessionHash("user-session-42"),
    );
  });

  it("defaults to 'default' when _sessionKey is missing", async () => {
    const spy = vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: { output: "ok", output_vars: {} },
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    await tool.execute("c1", { action: "exec", params: { command: "ls" } });

    expect(spy.mock.calls[0][0].session_hash).toBe(sessionHash("default"));
  });

  it("prefers _agentId over _sessionKey for session_hash", async () => {
    const spy = vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: { output: "ok", output_vars: {} },
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    await tool.execute("c1", {
      action: "exec",
      params: { command: "ls" },
      _agentId: "agent-global-id",
      _sessionKey: "telegram-session-123",
    } as any);

    expect(spy.mock.calls[0][0].session_hash).toBe(
      sessionHash("agent-global-id"),
    );
  });

  it("falls back to _sessionKey when _agentId is absent", async () => {
    const spy = vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: { output: "ok", output_vars: {} },
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    await tool.execute("c1", {
      action: "exec",
      params: { command: "ls" },
      _sessionKey: "telegram-session-123",
    } as any);

    expect(spy.mock.calls[0][0].session_hash).toBe(
      sessionHash("telegram-session-123"),
    );
  });
});

// --- mounts propagation ---

describe("execute() mounts", () => {
  it("passes mounts array to submitProposal", async () => {
    const spy = vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: { output: "ok", output_vars: {} },
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(
      client,
      catalog,
      DEFAULT_CONFIG,
      "/home/user/project",
    );

    await tool.execute("c1", { action: "exec", params: { command: "ls" } });

    expect(spy.mock.calls[0][0].mounts).toEqual([
      { host_path: "/home/user/project", container_path: "/workspace", mode: "rw" },
    ]);
  });
});

// --- gatewayHost/gatewayPort config ---

describe("execute() gateway config", () => {
  it("uses custom gatewayHost and gatewayPort in notify_url", async () => {
    const spy = vi
      .spyOn(client, "submitProposal")
      .mockReturnValue(new Promise(() => {}));

    const catalog = new Catalog(CONFIRM_CATALOG);
    const tool = createSafeClawTool(
      client,
      catalog,
      {
        kernelUrl: "http://localhost:7400",
        gatewayHost: "172.18.0.1",
        gatewayPort: 9999,
      },
      "/ws",
    );

    await tool.execute("c1", { action: "exec", params: { command: "npm install" } });

    expect(spy.mock.calls[0][0].notify_url).toContain(
      "http://172.18.0.1:9999/",
    );
  });

  it("defaults to localhost:18789", async () => {
    const spy = vi
      .spyOn(client, "submitProposal")
      .mockReturnValue(new Promise(() => {}));

    const catalog = new Catalog(CONFIRM_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    await tool.execute("c1", { action: "exec", params: { command: "npm install" } });

    expect(spy.mock.calls[0][0].notify_url).toContain(
      "http://localhost:18789/",
    );
  });
});

// --- human-confirm fast resolve (learned policy auto-approve) ---

describe("execute() human-confirm fast resolve", () => {
  it("returns result when kernel resolves within 500ms", async () => {
    // Learned policy auto-approves server-side → submitProposal resolves fast
    vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: { output: "auto-approved by policy", output_vars: {} },
    });

    const catalog = new Catalog(CONFIRM_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    const result = await tool.execute("c1", {
      action: "exec",
      params: { command: "git status" },
    });

    // Should return formatted result, NOT approval prompt
    expect(result.content[0].text).toContain("auto-approved by policy");
    expect(result.content[0].text).not.toContain("requires approval");
    // Should clean up pending store
    expect(pendingProposals.size).toBe(0);
  });

  it("returns result when kernel denies within 500ms", async () => {
    // Learned deny rule → instant denial, no approval prompt
    vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "denied",
      reason: "Denied by learned policy",
    });

    const catalog = new Catalog(CONFIRM_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    const result = await tool.execute("c1", {
      action: "exec",
      params: { command: "rm -rf /" },
    });

    expect(result.content[0].text).toContain("[DENIED]");
    expect(result.content[0].text).not.toContain("requires approval");
    expect(pendingProposals.size).toBe(0);
  });
});

// --- rate_limited through execute() ---

describe("execute() rate_limited", () => {
  it("auto-approve path: formats rate_limited response", async () => {
    vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "rate_limited",
      reason: "5 per minute exceeded",
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    const result = await tool.execute("c1", {
      action: "exec",
      params: { command: "ls" },
    });

    expect(result.content[0].text).toContain("[RATE LIMITED]");
    expect(result.content[0].text).toContain("5 per minute exceeded");
  });
});

// --- failed through execute() ---

describe("execute() failed", () => {
  it("auto-approve path: formats failed response with error", async () => {
    vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "failed",
      result: {
        output: "Permission denied",
        output_vars: {},
        error: "exit code 126",
      },
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    const result = await tool.execute("c1", {
      action: "exec",
      params: { command: "cat /etc/shadow" },
    });

    expect(result.content[0].text).toContain("[FAILED]");
    expect(result.content[0].text).toContain("exit code 126");
  });
});

// --- abort signal on auto-approve path ---

describe("execute() abort signal", () => {
  it("passes abort signal to submitProposal on auto-approve", async () => {
    const spy = vi.spyOn(client, "submitProposal").mockResolvedValue({
      status: "completed",
      result: { output: "ok", output_vars: {} },
    });

    const catalog = new Catalog(AUTO_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    const controller = new AbortController();
    await tool.execute(
      "c1",
      { action: "exec", params: { command: "ls" } },
      controller.signal,
    );

    // Second argument to submitProposal is the signal
    expect(spy.mock.calls[0][1]).toBe(controller.signal);
  });

  it("does NOT pass abort signal on human-confirm (fire-and-forget)", async () => {
    const spy = vi
      .spyOn(client, "submitProposal")
      .mockReturnValue(new Promise(() => {}));

    const catalog = new Catalog(CONFIRM_CATALOG);
    const tool = createSafeClawTool(client, catalog, DEFAULT_CONFIG, "/ws");

    const controller = new AbortController();
    await tool.execute(
      "c1",
      { action: "exec", params: { command: "npm install" } },
      controller.signal,
    );

    // Human-confirm fires without signal — let it block in Validance
    expect(spy.mock.calls[0].length).toBe(1);
  });
});
