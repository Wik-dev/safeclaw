import { describe, it, expect, afterEach } from "vitest";
import { pendingProposals, gcPending, type PendingEntry } from "../src/pending-store.js";

afterEach(() => {
  pendingProposals.clear();
});

function makeDummyEntry(overrides?: Partial<PendingEntry>): PendingEntry {
  return {
    promise: Promise.resolve({ status: "completed" as const }),
    approvalId: null,
    action: "exec",
    params: { command: "ls" },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("pendingProposals", () => {
  it("stores and retrieves entries", () => {
    const entry = makeDummyEntry();
    pendingProposals.set("abc", entry);

    expect(pendingProposals.get("abc")).toBe(entry);
    expect(pendingProposals.size).toBe(1);
  });

  it("links approvalId from webhook", () => {
    const entry = makeDummyEntry();
    pendingProposals.set("abc", entry);

    entry.approvalId = "kernel-approval-123";
    expect(pendingProposals.get("abc")!.approvalId).toBe("kernel-approval-123");
  });
});

describe("gcPending", () => {
  it("removes entries older than 10 minutes", () => {
    pendingProposals.set("old", makeDummyEntry({
      createdAt: Date.now() - 700_000,
    }));
    pendingProposals.set("fresh", makeDummyEntry({
      createdAt: Date.now(),
    }));

    gcPending();

    expect(pendingProposals.has("old")).toBe(false);
    expect(pendingProposals.has("fresh")).toBe(true);
  });

  it("keeps entries within 10-minute window", () => {
    pendingProposals.set("recent", makeDummyEntry({
      createdAt: Date.now() - 300_000,
    }));

    gcPending();

    expect(pendingProposals.has("recent")).toBe(true);
  });
});
