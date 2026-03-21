import { describe, it, expect, beforeEach } from "vitest";
import { pendingProposals, gcPending, addPending, MAX_PENDING } from "../../src/pending-store.js";
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

// ---------------------------------------------------------------------------
// addPending — bounded store (MAX_PENDING cap)
// ---------------------------------------------------------------------------

describe("addPending", () => {

  it("accepts up to MAX_PENDING entries", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_PENDING; i++) {
      addPending(`id-${i}`, makeEntry({ createdAt: now + i }));
    }
    expect(pendingProposals.size).toBe(MAX_PENDING);
  });

  it("evicts the oldest entry when adding beyond MAX_PENDING", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_PENDING; i++) {
      addPending(`id-${i}`, makeEntry({ createdAt: now + i }));
    }

    addPending("overflow", makeEntry({ createdAt: now + MAX_PENDING }));

    expect(pendingProposals.size).toBe(MAX_PENDING);
    expect(pendingProposals.has("id-0")).toBe(false); // oldest evicted
    expect(pendingProposals.has("overflow")).toBe(true);
  });

  it("reclaims via GC before evicting recent entries", () => {
    const now = Date.now();
    // Directly insert 50 expired + 50 recent to reach cap
    for (let i = 0; i < 50; i++) {
      pendingProposals.set(`old-${i}`, makeEntry({ createdAt: now - 700_000 + i }));
    }
    for (let i = 0; i < 50; i++) {
      pendingProposals.set(`recent-${i}`, makeEntry({ createdAt: now + i }));
    }
    expect(pendingProposals.size).toBe(MAX_PENDING);

    // addPending GCs first → 50 expired removed → size 50 → no eviction needed
    addPending("new", makeEntry({ createdAt: now + 100 }));

    expect(pendingProposals.size).toBe(51); // 50 recent + "new"
    expect(pendingProposals.has("recent-0")).toBe(true);
    expect(pendingProposals.has("new")).toBe(true);
  });
});
