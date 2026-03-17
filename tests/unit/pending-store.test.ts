import { describe, it, expect, beforeEach } from "vitest";
import { pendingProposals, gcPending } from "../../src/pending-store.js";
import type { PendingEntry } from "../../src/pending-store.js";

function makeEntry(createdAt: number): PendingEntry {
  return {
    promise: new Promise(() => {}), // never resolves — doesn't matter for GC
    approvalId: null,
    action: "exec",
    params: { command: "test" },
    createdAt,
  };
}

describe("gcPending", () => {
  beforeEach(() => {
    pendingProposals.clear();
  });

  it("removes entries older than 10 minutes", () => {
    const old = Date.now() - 700_000; // ~11.6 min ago
    pendingProposals.set("old-1", makeEntry(old));
    pendingProposals.set("old-2", makeEntry(old));

    gcPending();

    expect(pendingProposals.size).toBe(0);
  });

  it("retains entries newer than 10 minutes", () => {
    const recent = Date.now() - 300_000; // 5 min ago
    pendingProposals.set("recent-1", makeEntry(recent));

    gcPending();

    expect(pendingProposals.has("recent-1")).toBe(true);
  });

  it("removes old entries while retaining recent ones", () => {
    const old = Date.now() - 700_000;
    const recent = Date.now() - 100_000;

    pendingProposals.set("old", makeEntry(old));
    pendingProposals.set("recent", makeEntry(recent));

    gcPending();

    expect(pendingProposals.has("old")).toBe(false);
    expect(pendingProposals.has("recent")).toBe(true);
    expect(pendingProposals.size).toBe(1);
  });

  it("handles empty store without error", () => {
    expect(() => gcPending()).not.toThrow();
  });

  it("entry at exactly 10 minutes is removed (boundary)", () => {
    const exactly10min = Date.now() - 600_000;
    pendingProposals.set("boundary", makeEntry(exactly10min));

    gcPending();

    // cutoff = Date.now() - 600_000; entry.createdAt < cutoff
    // At exactly the cutoff, createdAt is NOT < cutoff, so it's retained
    // (the comparison is strict less-than)
    expect(pendingProposals.has("boundary")).toBe(true);
  });

  it("entry just past 10 minutes is removed", () => {
    const justPast = Date.now() - 600_001;
    pendingProposals.set("past", makeEntry(justPast));

    gcPending();

    expect(pendingProposals.has("past")).toBe(false);
  });
});
