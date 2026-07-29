import { describe, it, expect } from "vitest";
import { computeDiff } from "./diff";
import type { DiffLine } from "./diff";
import { seedLineChoices, buttonState, filterDocs, docStatus } from "./conflict-view-logic";

describe("seedLineChoices", () => {
  it("defaults removed→included, added→excluded for an overlapping change", () => {
    const diff = computeDiff("X", "Y"); // one line replaced: overlapping removed+added
    const choices = new Map<number, boolean>();
    seedLineChoices(diff, choices);
    diff.forEach((line, i) => {
      if (line.type === "removed") expect(choices.get(i)).toBe(true);
      if (line.type === "added") expect(choices.get(i)).toBe(false);
    });
  });

  it("includes all lines of a one-sided (pure addition) change", () => {
    const diff = computeDiff("A", "A\nB"); // B added, no removal
    const choices = new Map<number, boolean>();
    seedLineChoices(diff, choices);
    diff.forEach((line, i) => {
      if (line.type === "added") expect(choices.get(i)).toBe(true);
    });
  });

  it("never overwrites a choice the user already made", () => {
    const diff = computeDiff("X", "Y");
    const removedIdx = diff.findIndex((l) => l.type === "removed");
    const choices = new Map<number, boolean>([[removedIdx, false]]); // user set it false
    seedLineChoices(diff, choices);
    expect(choices.get(removedIdx)).toBe(false); // preserved, not re-seeded to true
  });
});

describe("buttonState", () => {
  const diff: DiffLine[] = [
    { type: "removed", text: "a" },
    { type: "added", text: "b" },
    { type: "context", text: "c" },
  ];

  it("recognises the all-local selection (keep removed, drop added)", () => {
    const choices = new Map([[0, true], [1, false]]);
    expect(buttonState(diff, choices)).toEqual({ isAllLocal: true, isAllRemote: false, isAllBoth: false });
  });

  it("recognises the all-remote selection (drop removed, keep added)", () => {
    const choices = new Map([[0, false], [1, true]]);
    expect(buttonState(diff, choices)).toEqual({ isAllLocal: false, isAllRemote: true, isAllBoth: false });
  });

  it("recognises include-both (every non-context line included)", () => {
    const choices = new Map([[0, true], [1, true]]);
    expect(buttonState(diff, choices)).toEqual({ isAllLocal: false, isAllRemote: false, isAllBoth: true });
  });
});

describe("filterDocs", () => {
  const docs = [
    { title: "Alpha", project: "p1", category: "c1" },
    { title: "Beta", project: "p2", category: "c1" },
    { title: "Gamma", project: "p1", category: "c2" },
  ];
  const noStatus = () => "synced";

  it("returns everything when all filters are empty", () => {
    expect(filterDocs(docs, { project: "", category: "", status: "", search: "" }, noStatus)).toHaveLength(3);
  });

  it("filters by project and category conjunctively", () => {
    const out = filterDocs(docs, { project: "p1", category: "c1", status: "", search: "" }, noStatus);
    expect(out.map((d) => d.title)).toEqual(["Alpha"]);
  });

  it("filters by case-insensitive title search", () => {
    const out = filterDocs(docs, { project: "", category: "", status: "", search: "eta" }, noStatus);
    expect(out.map((d) => d.title)).toEqual(["Beta"]);
  });

  it("filters by status via the supplied resolver", () => {
    const statusOf = (d: { title: string }) => (d.title === "Gamma" ? "not-downloaded" : "synced");
    const out = filterDocs(docs, { project: "", category: "", status: "not-downloaded", search: "" }, statusOf);
    expect(out.map((d) => d.title)).toEqual(["Gamma"]);
  });
});

describe("docStatus", () => {
  it("is synced only with both an entry and an existing file", () => {
    expect(docStatus(true, true)).toBe("synced");
    expect(docStatus(true, false)).toBe("not-downloaded");
    expect(docStatus(false, false)).toBe("not-downloaded");
  });
});
