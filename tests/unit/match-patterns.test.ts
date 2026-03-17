import { describe, it, expect } from "vitest";
import {
  commandPrefix,
  directoryPrefix,
  urlOrigin,
  deriveMatchPattern,
} from "../../src/match-patterns.js";

// --- commandPrefix ---

describe("commandPrefix", () => {
  it("extracts first token with wildcard", () => {
    expect(commandPrefix("git status")).toBe("git *");
  });

  it("extracts first token from multi-word command", () => {
    expect(commandPrefix("npm run build")).toBe("npm *");
  });

  it("returns exact match for single-word command", () => {
    expect(commandPrefix("ls")).toBe("ls");
  });

  it("returns wildcard for empty string", () => {
    expect(commandPrefix("")).toBe("*");
  });

  it("trims leading/trailing whitespace", () => {
    expect(commandPrefix("  git status  ")).toBe("git *");
  });

  it("handles single word with surrounding whitespace", () => {
    expect(commandPrefix("  ls  ")).toBe("ls");
  });
});

// --- directoryPrefix ---

describe("directoryPrefix", () => {
  it("extracts directory from file path", () => {
    expect(directoryPrefix("src/index.ts")).toBe("src/*");
  });

  it("extracts nested directory path", () => {
    expect(directoryPrefix("docs/api/README.md")).toBe("docs/api/*");
  });

  it("returns wildcard for root-level file", () => {
    expect(directoryPrefix("file.txt")).toBe("*");
  });

  it("returns wildcard for empty string", () => {
    expect(directoryPrefix("")).toBe("*");
  });
});

// --- urlOrigin ---

describe("urlOrigin", () => {
  it("extracts origin from HTTPS URL", () => {
    expect(urlOrigin("https://api.x.com/data")).toBe("https://api.x.com/*");
  });

  it("extracts origin with port", () => {
    expect(urlOrigin("http://localhost:3000/path")).toBe(
      "http://localhost:3000/*",
    );
  });

  it("returns wildcard for non-URL string", () => {
    expect(urlOrigin("not-a-url")).toBe("*");
  });

  it("returns wildcard for empty string", () => {
    expect(urlOrigin("")).toBe("*");
  });
});

// --- deriveMatchPattern ---

describe("deriveMatchPattern", () => {
  // exec
  it("exec → command prefix", () => {
    expect(deriveMatchPattern("exec", { command: "git status" })).toEqual({
      command: "git *",
    });
  });

  it("exec with missing command → wildcard", () => {
    expect(deriveMatchPattern("exec", {})).toEqual({ command: "*" });
  });

  // write / edit / apply_patch
  it("write → directory prefix", () => {
    expect(deriveMatchPattern("write", { path: "src/index.ts" })).toEqual({
      path: "src/*",
    });
  });

  it("edit → directory prefix", () => {
    expect(deriveMatchPattern("edit", { path: "docs/api/file.md" })).toEqual({
      path: "docs/api/*",
    });
  });

  it("apply_patch → directory prefix", () => {
    expect(
      deriveMatchPattern("apply_patch", { path: "config.json" }),
    ).toEqual({ path: "*" });
  });

  // web_fetch
  it("web_fetch → URL origin", () => {
    expect(
      deriveMatchPattern("web_fetch", { url: "https://api.x.com/data" }),
    ).toEqual({ url: "https://api.x.com/*" });
  });

  it("web_fetch with missing url → wildcard", () => {
    expect(deriveMatchPattern("web_fetch", {})).toEqual({ url: "*" });
  });

  // browser
  it("browser with action → action pattern", () => {
    expect(deriveMatchPattern("browser", { action: "goto" })).toEqual({
      action: "goto",
    });
  });

  it("browser without action → empty pattern", () => {
    expect(deriveMatchPattern("browser", {})).toEqual({});
  });

  // message
  it("message with channel → channel pattern", () => {
    expect(
      deriveMatchPattern("message", { channel: "#general" }),
    ).toEqual({ channel: "#general" });
  });

  it("message with target → target pattern", () => {
    expect(deriveMatchPattern("message", { target: "user@example.com" })).toEqual({
      target: "user@example.com",
    });
  });

  it("message with both channel and target → both", () => {
    expect(
      deriveMatchPattern("message", {
        channel: "#ops",
        target: "alice",
      }),
    ).toEqual({ channel: "#ops", target: "alice" });
  });

  it("message with no channel or target → empty", () => {
    expect(deriveMatchPattern("message", { body: "hello" })).toEqual({});
  });

  // cron / canvas / nodes / process — action-based
  it("cron with action → action pattern", () => {
    expect(deriveMatchPattern("cron", { action: "schedule" })).toEqual({
      action: "schedule",
    });
  });

  it("process without action → empty", () => {
    expect(deriveMatchPattern("process", {})).toEqual({});
  });

  // sessions_send
  it("sessions_send with session_key → pattern", () => {
    expect(
      deriveMatchPattern("sessions_send", { session_key: "abc-123" }),
    ).toEqual({ session_key: "abc-123" });
  });

  it("sessions_send without session_key → empty", () => {
    expect(deriveMatchPattern("sessions_send", {})).toEqual({});
  });

  // unknown action
  it("unknown action → empty pattern", () => {
    expect(
      deriveMatchPattern("unknown_action", { foo: "bar" }),
    ).toEqual({});
  });

  // CRITICAL: {} must never be returned for exec (would auto-approve everything)
  it("exec never returns empty pattern", () => {
    const result = deriveMatchPattern("exec", {});
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("write never returns empty pattern", () => {
    const result = deriveMatchPattern("write", {});
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  it("web_fetch never returns empty pattern", () => {
    const result = deriveMatchPattern("web_fetch", {});
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});
