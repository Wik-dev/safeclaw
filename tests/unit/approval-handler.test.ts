import { describe, it, expect } from "vitest";
import { getQueryParam, raceTimeout } from "../../src/approval-handler.js";

// --- getQueryParam ---

describe("getQueryParam", () => {
  it("extracts a query parameter from URL path", () => {
    expect(
      getQueryParam("/safeclaw/notify?proposalId=abc-123", "proposalId"),
    ).toBe("abc-123");
  });

  it("returns null for missing key", () => {
    expect(
      getQueryParam("/safeclaw/notify?proposalId=abc-123", "other"),
    ).toBeNull();
  });

  it("returns null when no query string", () => {
    expect(getQueryParam("/safeclaw/notify", "proposalId")).toBeNull();
  });

  it("returns null for undefined url", () => {
    expect(getQueryParam(undefined, "proposalId")).toBeNull();
  });

  it("handles multiple query parameters", () => {
    const url = "/notify?proposalId=abc&action=exec&session=xyz";
    expect(getQueryParam(url, "proposalId")).toBe("abc");
    expect(getQueryParam(url, "action")).toBe("exec");
    expect(getQueryParam(url, "session")).toBe("xyz");
  });

  it("handles URL-encoded values", () => {
    expect(
      getQueryParam("/notify?key=hello%20world", "key"),
    ).toBe("hello world");
  });

  it("returns empty string for key with no value", () => {
    expect(getQueryParam("/notify?key=", "key")).toBe("");
  });
});

// --- raceTimeout ---

describe("raceTimeout", () => {
  it("returns value when promise resolves before timeout", async () => {
    const promise = Promise.resolve("done");
    const result = await raceTimeout(promise, 1000);
    expect(result).toBe("done");
  });

  it("returns null when timeout fires first", async () => {
    const never = new Promise<string>(() => {}); // never resolves
    const result = await raceTimeout(never, 50);
    expect(result).toBeNull();
  });

  it("returns value for already-resolved promise", async () => {
    const result = await raceTimeout(Promise.resolve(42), 50);
    expect(result).toBe(42);
  });

  it("propagates rejection from the promise", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(raceTimeout(failing, 1000)).rejects.toThrow("boom");
  });
});
