import { describe, it, expect } from "vitest";
import { parseSections, serializeSections } from "./section-parser";

describe("parseSections", () => {
  it("returns preamble only for body with no headings", () => {
    const result = parseSections("Just some text\nand more text");
    expect(result.size).toBe(1);
    expect(result.has("__preamble")).toBe(true);
    expect(result.get("__preamble")!.body).toBe("Just some text\nand more text");
    expect(result.get("__preamble")!.heading).toBe("");
  });

  it("returns empty map for empty body", () => {
    const result = parseSections("");
    expect(result.size).toBe(0);
  });

  it("returns empty map for whitespace-only body", () => {
    const result = parseSections("   \n\n  ");
    expect(result.size).toBe(0);
  });

  it("parses multiple h3 sections", () => {
    const body = "### Alice\nAlice content\n\n### Bob\nBob content";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.get("alice")!.heading).toBe("### Alice");
    expect(result.get("alice")!.body).toBe("Alice content\n");
    expect(result.get("bob")!.heading).toBe("### Bob");
    expect(result.get("bob")!.body).toBe("Bob content");
  });

  it("preserves preamble before first heading", () => {
    const body = "Top content\n\n### Section\nSection body";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.get("__preamble")!.body).toBe("Top content\n");
    expect(result.get("section")!.body).toBe("Section body");
  });

  it("handles sections with blank lines in body", () => {
    const body = "### Notes\nLine 1\n\nLine 2\n\nLine 3\n\n### Other\nStuff";
    const result = parseSections(body);
    expect(result.get("notes")!.body).toBe("Line 1\n\nLine 2\n\nLine 3\n");
    expect(result.get("other")!.body).toBe("Stuff");
  });

  it("does not split on h1, h2, or h4 headings", () => {
    const body = "# Big\n## Medium\n### Real\nContent\n#### Small\nMore";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.has("__preamble")).toBe(true);
    expect(result.get("__preamble")!.body).toBe("# Big\n## Medium\n");
    expect(result.get("real")!.body).toBe("Content\n#### Small\nMore");
  });

  it("deduplicates heading keys with suffix", () => {
    const body = "### Dupe\nFirst\n### Dupe\nSecond";
    const result = parseSections(body);
    expect(result.size).toBe(2);
    expect(result.has("dupe")).toBe(true);
    expect(result.has("dupe-2")).toBe(true);
    expect(result.get("dupe")!.body).toBe("First\n");
    expect(result.get("dupe-2")!.body).toBe("Second");
  });

  it("computes hash from normalized content", () => {
    const body1 = "### Test\nContent   \n\n";
    const body2 = "### Test\nContent\n";
    const r1 = parseSections(body1);
    const r2 = parseSections(body2);
    expect(r1.get("test")!.hash).toBe(r2.get("test")!.hash);
  });
});

describe("serializeSections", () => {
  it("reconstructs preamble-only body", () => {
    const sections = parseSections("Just some text");
    const result = serializeSections(sections);
    expect(result).toBe("Just some text");
  });

  it("reconstructs sections with headings", () => {
    const body = "### Alice\nContent A\n\n### Bob\nContent B";
    const sections = parseSections(body);
    const result = serializeSections(sections);
    expect(result).toBe("### Alice\nContent A\n\n### Bob\nContent B");
  });

  it("reconstructs preamble + sections", () => {
    const body = "Top stuff\n\n### Section\nBody here";
    const sections = parseSections(body);
    const result = serializeSections(sections);
    expect(result).toBe("Top stuff\n\n### Section\nBody here");
  });

  it("round-trips complex document", () => {
    const body = [
      "Preamble line 1",
      "Preamble line 2",
      "",
      "### Alpha",
      "Alpha body",
      "",
      "Alpha continued",
      "",
      "### Beta",
      "Beta body",
      "",
      "### Gamma",
      "Gamma body",
    ].join("\n");
    const sections = parseSections(body);
    const result = serializeSections(sections);
    expect(result).toBe(body);
  });
});
