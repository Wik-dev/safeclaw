import { describe, it, expect } from "vitest";
import { effectiveApprovalTier } from "../../src/meta-tool.js";
import { STANDARD_SAFE_EXEC } from "../../src/trust-profiles.js";

describe("STANDARD_SAFE_EXEC", () => {
  it("contains common read-only commands", () => {
    for (const cmd of ["ls", "cat", "grep", "pwd", "find", "echo", "diff", "stat"]) {
      expect(STANDARD_SAFE_EXEC.has(cmd), `${cmd} should be in STANDARD_SAFE_EXEC`).toBe(true);
    }
  });

  it("does not contain destructive commands", () => {
    for (const cmd of ["rm", "mv", "cp", "chmod", "chown", "kill", "git", "npm", "python"]) {
      expect(STANDARD_SAFE_EXEC.has(cmd), `${cmd} should NOT be in STANDARD_SAFE_EXEC`).toBe(false);
    }
  });
});

describe("effectiveApprovalTier — safe exec override", () => {
  it("downgrades human-confirm → auto-approve for ls in standard profile", () => {
    expect(
      effectiveApprovalTier("exec", { command: "ls" }, "human-confirm", "standard"),
    ).toBe("auto-approve");
  });

  it("downgrades human-confirm → auto-approve for ls with args in standard profile", () => {
    expect(
      effectiveApprovalTier("exec", { command: "ls -la /tmp" }, "human-confirm", "standard"),
    ).toBe("auto-approve");
  });

  it("downgrades for power-user profile too", () => {
    expect(
      effectiveApprovalTier("exec", { command: "grep -r foo src/" }, "human-confirm", "power-user"),
    ).toBe("auto-approve");
  });

  it("keeps human-confirm in conservative profile", () => {
    expect(
      effectiveApprovalTier("exec", { command: "ls" }, "human-confirm", "conservative"),
    ).toBe("human-confirm");
  });

  it("keeps human-confirm for unknown/destructive commands", () => {
    expect(
      effectiveApprovalTier("exec", { command: "rm -rf /" }, "human-confirm", "standard"),
    ).toBe("human-confirm");

    expect(
      effectiveApprovalTier("exec", { command: "git push origin main" }, "human-confirm", "standard"),
    ).toBe("human-confirm");

    expect(
      effectiveApprovalTier("exec", { command: "npm install" }, "human-confirm", "standard"),
    ).toBe("human-confirm");
  });

  it("passes through non-exec actions unchanged", () => {
    expect(
      effectiveApprovalTier("write", { path: "foo.txt" }, "human-confirm", "standard"),
    ).toBe("human-confirm");

    expect(
      effectiveApprovalTier("browser", { action: "goto" }, "human-confirm", "standard"),
    ).toBe("human-confirm");
  });

  it("passes through auto-approve and always-deny unchanged", () => {
    expect(
      effectiveApprovalTier("exec", { command: "ls" }, "auto-approve", "standard"),
    ).toBe("auto-approve");

    expect(
      effectiveApprovalTier("exec", { command: "ls" }, "always-deny", "standard"),
    ).toBe("always-deny");
  });

  it("handles missing command gracefully — keeps human-confirm", () => {
    expect(
      effectiveApprovalTier("exec", {}, "human-confirm", "standard"),
    ).toBe("human-confirm");
  });
});
