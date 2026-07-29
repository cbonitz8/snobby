import { describe, it, expect } from "vitest";
import { reconcile, type ReconcileInput } from "./reconciler";

// Minimal input; individual tests override what they exercise.
function input(over: Partial<ReconcileInput>): ReconcileInput {
  return {
    localBody: "",
    remoteBody: "",
    serverAncestor: null,
    cachedAncestor: null,
    ...over,
  };
}

describe("reconcile — server-unchanged gate", () => {
  it("returns no-change when the remote hash still matches the stored hash", () => {
    const out = reconcile(
      input({ remoteContentHash: "h", storedContentHash: "h", localBody: "a", remoteBody: "b" }),
    );
    expect(out).toEqual({ kind: "no-change" });
  });

  it("does not treat a missing remote hash as unchanged", () => {
    // remoteContentHash undefined must not equal an undefined stored hash
    const out = reconcile(input({ localBody: "x", remoteBody: "x", storedLocalHash: "h", localHash: "h" }));
    expect(out.kind).not.toBe("no-change");
  });
});

describe("reconcile — local divergence detection", () => {
  it("overwrite-local when server changed and local is clean (modern hash match)", () => {
    const out = reconcile(
      input({
        remoteContentHash: "new",
        storedContentHash: "old",
        storedLocalHash: "lh",
        localHash: "lh", // unchanged
        localBody: "local",
        remoteBody: "remote",
      }),
    );
    expect(out).toEqual({ kind: "overwrite-local" });
  });

  it("overwrite-local via legacy fallback when local body equals the cached ancestor", () => {
    const out = reconcile(
      input({ storedLocalHash: undefined, cachedAncestor: "same", localBody: "same", remoteBody: "remote" }),
    );
    expect(out).toEqual({ kind: "overwrite-local" });
  });

  it("overwrite-local via legacy direct compare when no ancestor and local equals remote", () => {
    const out = reconcile(input({ storedLocalHash: undefined, cachedAncestor: null, localBody: "x", remoteBody: "x" }));
    expect(out).toEqual({ kind: "overwrite-local" });
  });

  it("merges (not overwrite) when legacy direct compare shows local differs from remote", () => {
    const out = reconcile(
      input({ storedLocalHash: undefined, cachedAncestor: null, localBody: "### a\nX", remoteBody: "### a\nY" }),
    );
    expect(out.kind).not.toBe("overwrite-local");
    expect(out.kind).not.toBe("no-change");
  });
});

describe("reconcile — three-way merge decision", () => {
  const base = "### a\nA1\n### b\nB1";
  const localEditsA = "### a\nA1-local\n### b\nB1";
  const remoteEditsB = "### a\nA1\n### b\nB1-remote";

  it("auto-merges non-conflicting section edits", () => {
    const out = reconcile(
      input({
        storedLocalHash: "lh",
        localHash: "changed", // diverged
        cachedAncestor: base,
        localBody: localEditsA,
        remoteBody: remoteEditsB,
      }),
    );
    expect(out.kind).toBe("auto-merged");
    if (out.kind === "auto-merged") {
      expect(out.mergedBody).toContain("A1-local");
      expect(out.mergedBody).toContain("B1-remote");
    }
  });

  it("reports a conflict when the same section changed on both sides", () => {
    const out = reconcile(
      input({
        storedLocalHash: "lh",
        localHash: "changed",
        cachedAncestor: "### a\nA1",
        localBody: "### a\nA1-local",
        remoteBody: "### a\nA1-remote",
      }),
    );
    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") {
      expect(out.sectionConflicts).toHaveLength(1);
      expect(out.sectionConflicts[0]!.key).toBe("a");
    }
  });
});

describe("reconcile — ancestor precedence", () => {
  it("prefers the server ancestor over the cached ancestor", () => {
    // With serverAncestor == local, section 'a' reads as accepted_remote → clean merge.
    // With cachedAncestor (different from both), it would read as a conflict.
    const out = reconcile(
      input({
        localAlreadyDiverged: true,
        localBody: "### a\nX",
        remoteBody: "### a\nY",
        serverAncestor: "### a\nX",
        cachedAncestor: "### a\nZ",
      }),
    );
    expect(out.kind).toBe("auto-merged"); // proves the server ancestor won
  });
});

describe("reconcile — push shortcut", () => {
  it("skips detection and merges when localAlreadyDiverged is set", () => {
    const out = reconcile(
      input({
        localAlreadyDiverged: true,
        localBody: "### a\nA1-local",
        remoteBody: "### a\nA1-remote",
        cachedAncestor: "### a\nA1",
      }),
    );
    expect(out.kind).toBe("conflict");
  });
});
