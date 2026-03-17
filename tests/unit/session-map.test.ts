import { describe, it, expect, beforeEach } from "vitest";
import { sessionHash, clearSessionCache } from "../../src/session-map.js";

describe("sessionHash", () => {
  beforeEach(() => {
    clearSessionCache();
  });

  it("returns a 64-character hex string", () => {
    const hash = sessionHash("test-key");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same key returns same hash", () => {
    const a = sessionHash("key-1");
    const b = sessionHash("key-1");
    expect(a).toBe(b);
  });

  it("different keys produce different hashes", () => {
    const a = sessionHash("key-1");
    const b = sessionHash("key-2");
    expect(a).not.toBe(b);
  });

  it("uses safeclaw: prefix (known hash for test vector)", async () => {
    // SHA-256("safeclaw:hello") — verify against a known value
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update("safeclaw:hello")
      .digest("hex");
    expect(sessionHash("hello")).toBe(expected);
  });

  it("empty string key produces valid hash", () => {
    const hash = sessionHash("");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("clearSessionCache", () => {
  it("clears cache without error", () => {
    sessionHash("cached-key");
    expect(() => clearSessionCache()).not.toThrow();
  });

  it("after clear, sessionHash still returns correct value", () => {
    const before = sessionHash("persistent");
    clearSessionCache();
    const after = sessionHash("persistent");
    expect(after).toBe(before);
  });
});
