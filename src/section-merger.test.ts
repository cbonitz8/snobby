import { describe, it, expect } from "vitest";
import { mergeSections } from "./section-merger";
import { parseSections } from "./section-parser";

// Helper: parse a markdown body into section map
function p(body: string) {
  return parseSections(body);
}

describe("mergeSections — three-way", () => {
  it("returns unchanged when all three are identical", () => {
    const base = p("### A\nContent");
    const local = p("### A\nContent");
    const remote = p("### A\nContent");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.conflicts).toHaveLength(0);
    expect(result.outcomes.get("a")!.status).toBe("unchanged");
  });

  it("accepts remote when only remote changed", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal");
    const remote = p("### A\nUpdated by remote");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("accepted_remote");
    expect(result.mergedBody).toContain("Updated by remote");
  });

  it("keeps local when only local changed", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nUpdated locally");
    const remote = p("### A\nOriginal");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("kept_local");
    expect(result.mergedBody).toContain("Updated locally");
  });

  it("detects conflict when both changed differently", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nLocal version");
    const remote = p("### A\nRemote version");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.key).toBe("a");
    expect(result.conflicts[0]!.localBody).toContain("Local version");
    expect(result.conflicts[0]!.remoteBody).toContain("Remote version");
    expect(result.conflicts[0]!.baseBody).toContain("Original");
  });

  it("treats convergent edits as unchanged", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nSame fix");
    const remote = p("### A\nSame fix");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("unchanged");
  });

  it("removes section deleted by remote", () => {
    const base = p("### A\nKeep\n\n### B\nRemove me");
    const local = p("### A\nKeep\n\n### B\nRemove me");
    const remote = p("### A\nKeep");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("deleted");
    expect(result.mergedBody).not.toContain("Remove me");
  });

  it("removes section deleted by local", () => {
    const base = p("### A\nKeep\n\n### B\nRemove me");
    const local = p("### A\nKeep");
    const remote = p("### A\nKeep\n\n### B\nRemove me");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("deleted");
    expect(result.mergedBody).not.toContain("Remove me");
  });

  it("removes section deleted by both", () => {
    const base = p("### A\nKeep\n\n### B\nGone");
    const local = p("### A\nKeep");
    const remote = p("### A\nKeep");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("deleted");
  });

  it("keeps section added locally", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal\n\n### B\nNew local");
    const remote = p("### A\nOriginal");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("added");
    expect(result.mergedBody).toContain("New local");
  });

  it("accepts section added remotely", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal");
    const remote = p("### A\nOriginal\n\n### B\nNew remote");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("b")!.status).toBe("added");
    expect(result.mergedBody).toContain("New remote");
  });

  it("no conflict when both add same section with same content", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal\n\n### B\nSame");
    const remote = p("### A\nOriginal\n\n### B\nSame");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
  });

  it("conflicts when both add same key with different content", () => {
    const base = p("### A\nOriginal");
    const local = p("### A\nOriginal\n\n### B\nLocal version");
    const remote = p("### A\nOriginal\n\n### B\nRemote version");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts[0]!.key).toBe("b");
    expect(result.conflicts[0]!.baseBody).toBeNull();
  });

  it("merges multiple sections independently", () => {
    const base = p("### A\nA base\n\n### B\nB base\n\n### C\nC base");
    const local = p("### A\nA local\n\n### B\nB base\n\n### C\nC base");
    const remote = p("### A\nA base\n\n### B\nB remote\n\n### C\nC base");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("kept_local");
    expect(result.outcomes.get("b")!.status).toBe("accepted_remote");
    expect(result.outcomes.get("c")!.status).toBe("unchanged");
    expect(result.mergedBody).toContain("A local");
    expect(result.mergedBody).toContain("B remote");
    expect(result.mergedBody).toContain("C base");
  });

  it("handles preamble changes", () => {
    const base = p("Preamble\n\n### A\nContent");
    const local = p("Updated preamble\n\n### A\nContent");
    const remote = p("Preamble\n\n### A\nContent");
    const result = mergeSections(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("__preamble")!.status).toBe("kept_local");
    expect(result.mergedBody).toContain("Updated preamble");
  });
});

describe("mergeSections — two-way fallback (null base)", () => {
  it("returns unchanged when local and remote match", () => {
    const local = p("### A\nSame");
    const remote = p("### A\nSame");
    const result = mergeSections(null, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.outcomes.get("a")!.status).toBe("unchanged");
  });

  it("keeps local-only section", () => {
    const local = p("### A\nLocal\n\n### B\nOnly here");
    const remote = p("### A\nLocal");
    const result = mergeSections(null, local, remote);
    expect(result.outcomes.get("b")!.status).toBe("kept_local");
  });

  it("accepts remote-only section", () => {
    const local = p("### A\nLocal");
    const remote = p("### A\nLocal\n\n### B\nRemote only");
    const result = mergeSections(null, local, remote);
    expect(result.outcomes.get("b")!.status).toBe("accepted_remote");
  });

  it("conflicts when same key has different content", () => {
    const local = p("### A\nLocal ver");
    const remote = p("### A\nRemote ver");
    const result = mergeSections(null, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts[0]!.baseBody).toBeNull();
  });
});
