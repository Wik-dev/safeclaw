#!/usr/bin/env node
/**
 * CLI entrypoint for @validance/safeclaw.
 *
 * Usage: npx @validance/safeclaw start
 *
 * Pulls/starts Docker Compose (Validance + PostgreSQL), loads catalog,
 * waits for health check, and prints connection info.
 */

import { execSync, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const composeFile = resolve(__dirname, "..", "docker", "docker-compose.yml");

const command = process.argv[2];

if (command === "start") {
  console.log("[safeclaw] Starting Validance + PostgreSQL...");

  try {
    execSync(`docker compose -f "${composeFile}" up -d`, {
      stdio: "inherit",
    });
  } catch {
    console.error("[safeclaw] Failed to start Docker Compose.");
    console.error("Make sure Docker is running and try again.");
    process.exit(1);
  }

  // Wait for health check
  const kernelUrl =
    process.env.VALIDANCE_URL ?? "http://localhost:7400";
  const maxRetries = 30;
  let healthy = false;

  console.log("[safeclaw] Waiting for Validance to be healthy...");

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${kernelUrl}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (healthy) {
    console.log(`\n[safeclaw] Validance running at ${kernelUrl}`);
    console.log("[safeclaw] Install the OpenClaw plugin:");
    console.log("  openclaw plugins install @validance/safeclaw");
    console.log("\nAdd to your OpenClaw config:");
    console.log(`  plugins.entries.@validance/safeclaw.config.kernelUrl: "${kernelUrl}"`);
  } else {
    console.error("[safeclaw] Validance did not become healthy in time.");
    console.error("Check logs: docker compose -f " + composeFile + " logs");
    process.exit(1);
  }
} else if (command === "stop") {
  console.log("[safeclaw] Stopping Validance...");
  execSync(`docker compose -f "${composeFile}" down`, { stdio: "inherit" });
} else if (command === "logs") {
  execSync(`docker compose -f "${composeFile}" logs -f`, { stdio: "inherit" });
} else {
  console.log("Usage: safeclaw <start|stop|logs>");
  process.exit(1);
}
