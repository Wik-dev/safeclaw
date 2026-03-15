import { describe, it, expect } from "vitest";
import { deriveMatchPattern } from "../src/match-patterns.js";

describe("deriveMatchPattern", () => {
  // -- exec --
  it("exec: multi-word command → first token + *", () => {
    expect(deriveMatchPattern("exec", { command: "git status" }))
      .toEqual({ command: "git *" });
  });

  it("exec: single-word command → exact match (no wildcard)", () => {
    expect(deriveMatchPattern("exec", { command: "ls" }))
      .toEqual({ command: "ls" });
  });

  it("exec: empty command → wildcard", () => {
    expect(deriveMatchPattern("exec", { command: "" }))
      .toEqual({ command: "*" });
  });

  it("exec: missing command param → wildcard", () => {
    expect(deriveMatchPattern("exec", {}))
      .toEqual({ command: "*" });
  });

  // -- browser --
  it("browser: action value → exact match", () => {
    expect(deriveMatchPattern("browser", { action: "navigate" }))
      .toEqual({ action: "navigate" });
  });

  it("browser: no action → empty pattern", () => {
    expect(deriveMatchPattern("browser", {}))
      .toEqual({});
  });

  // -- message --
  it("message: channel + target → both preserved", () => {
    expect(deriveMatchPattern("message", { channel: "telegram", target: "u123" }))
      .toEqual({ channel: "telegram", target: "u123" });
  });

  it("message: channel only → only channel", () => {
    expect(deriveMatchPattern("message", { channel: "slack" }))
      .toEqual({ channel: "slack" });
  });

  // -- write / edit / apply_patch --
  it("write: path with directory → directory prefix + /*", () => {
    expect(deriveMatchPattern("write", { path: "src/index.ts" }))
      .toEqual({ path: "src/*" });
  });

  it("edit: nested path → full directory prefix", () => {
    expect(deriveMatchPattern("edit", { path: "docs/api/README.md" }))
      .toEqual({ path: "docs/api/*" });
  });

  it("apply_patch: root file → wildcard", () => {
    expect(deriveMatchPattern("apply_patch", { path: "file.txt" }))
      .toEqual({ path: "*" });
  });

  // -- web_fetch --
  it("web_fetch: URL → origin + /*", () => {
    expect(deriveMatchPattern("web_fetch", { url: "https://api.x.com/data" }))
      .toEqual({ url: "https://api.x.com/*" });
  });

  it("web_fetch: invalid URL → wildcard", () => {
    expect(deriveMatchPattern("web_fetch", { url: "not-a-url" }))
      .toEqual({ url: "*" });
  });

  // -- sessions_send --
  it("sessions_send: session_key → exact match", () => {
    expect(deriveMatchPattern("sessions_send", { session_key: "abc" }))
      .toEqual({ session_key: "abc" });
  });

  // -- cron / canvas / nodes / process --
  it("cron: action → exact match", () => {
    expect(deriveMatchPattern("cron", { action: "create" }))
      .toEqual({ action: "create" });
  });

  it("canvas: action → exact match", () => {
    expect(deriveMatchPattern("canvas", { action: "update" }))
      .toEqual({ action: "update" });
  });

  // -- unknown action --
  it("unknown action → empty pattern (template-wide)", () => {
    expect(deriveMatchPattern("something_new", { foo: "bar" }))
      .toEqual({});
  });
});
