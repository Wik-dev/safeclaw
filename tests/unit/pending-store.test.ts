import { describe, it, expect, beforeEach } from "vitest";
import { pendingProposals, gcPending } from "../../src/pending-store.js";
import type { PendingEntry } from "../../src/pending-store.js";

function makeEntry(overrides?: Partial<PendingEntry>): PendingEntry {
  return {
    promise: new Promise(() => {}),
    approvalId: null,
    action: "exec",
    params: { command: "test" },
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  pendingProposals.clear();
});

// ---------------------------------------------------------------------------
// Store / retrieve basics
// ---------------------------------------------------------------------------

describe("pendingProposals", () => {
  it("stores and retrieves entries", () => {
    const entry = makeEntry();
    pendingProposals.set("abc", entry);

    expect(pendingProposals.get("abc")).toBe(entry);
    expect(pendingProposals.size).toBe(1);
  });

  it("links approvalId from webhook", () => {
    const entry = makeEntry();
    pendingProposals.set("abc", entry);

    entry.approvalId = "kernel-approval-123";
    expect(pendingProposals.get("abc")!.approvalId).toBe("kernel-approval-123");
  });
});

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

describe("gcPending", () => {

  it("removes entries older than 10 minutes", () => {
    const old = Date.now() - 700_000;
    pendingProposals.set("old-1", makeEntry({ createdAt: old }));
    pendingProposals.set("old-2", makeEntry({ createdAt: old }));

    gcPending();

    expect(pendingProposals.size).toBe(0);
  });

  it("retains entries newer than 10 minutes", () => {
    pendingProposals.set("recent-1", makeEntry({ createdAt: Date.now() - 300_000 }));

    gcPending();

    expect(pendingProposals.has("recent-1")).toBe(true);
  });

  it("removes old entries while retaining recent ones", () => {
    pendingProposals.set("old", makeEntry({ createdAt: Date.now() - 700_000 }));
    pendingProposals.set("recent", makeEntry({ createdAt: Date.now() - 100_000 }));

    gcPending();

    expect(pendingProposals.has("old")).toBe(false);
    expect(pendingProposals.has("recent")).toBe(true);
    expect(pendingProposals.size).toBe(1);
  });

  it("handles empty store without error", () => {
    expect(() => gcPending()).not.toThrow();
  });

  it("entry at exactly 10 minutes is retained (strict less-than)", () => {
    pendingProposals.set("boundary", makeEntry({ createdAt: Date.now() - 600_000 }));

    gcPending();

    expect(pendingProposals.has("boundary")).toBe(true);
  });

  it("entry just past 10 minutes is removed", () => {
    pendingProposals.set("past", makeEntry({ createdAt: Date.now() - 600_001 }));

    gcPending();

    expect(pendingProposals.has("past")).toBe(false);
  });
});
