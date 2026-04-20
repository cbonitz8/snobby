import { describe, it, expect } from "vitest";
import { stripFrontmatter } from "./frontmatter-manager";

describe("stripFrontmatter", () => {
  it("strips standard frontmatter and returns body", () => {
    const input = "---\nkey: val\n---\nbody";
    expect(stripFrontmatter(input)).toBe("body");
  });

  it("returns unchanged content when there is no frontmatter", () => {
    const input = "just some plain text\nwith multiple lines";
    expect(stripFrontmatter(input)).toBe(input);
  });

  it("returns empty string when frontmatter has no body", () => {
    const input = "---\nkey: val\n---";
    expect(stripFrontmatter(input)).toBe("");
  });

  it("strips leading newlines from the body after frontmatter", () => {
    const input = "---\nkey: val\n---\n\n\nbody starts here";
    expect(stripFrontmatter(input)).toBe("body starts here");
  });

  it("returns unchanged content for malformed frontmatter (no closing ---)", () => {
    const input = "---\nkey: val\nno closing delimiter";
    expect(stripFrontmatter(input)).toBe(input);
  });

  it("returns unchanged content when --- appears but not at file start", () => {
    const input = "some text\n---\nkey: val\n---\nbody";
    expect(stripFrontmatter(input)).toBe(input);
  });

  it("returns empty string for empty input", () => {
    expect(stripFrontmatter("")).toBe("");
  });

  it("only strips the first frontmatter block when --- appears in body", () => {
    const input = "---\ntitle: test\n---\nsome text\n---\nmore text";
    expect(stripFrontmatter(input)).toBe("some text\n---\nmore text");
  });

  it("handles frontmatter with multi-line YAML values", () => {
    const input = "---\ndescription: |\n  This is a\n  multi-line value\ntitle: test\n---\nbody content";
    expect(stripFrontmatter(input)).toBe("body content");
  });

  it("returns empty string when frontmatter delimiters have no content between them", () => {
    const input = "---\n---\nbody";
    expect(stripFrontmatter(input)).toBe("body");
  });

  it("strips only the first frontmatter block when multiple blocks exist", () => {
    const input = "---\nfirst: block\n---\nmiddle\n---\nsecond: block\n---\nend";
    expect(stripFrontmatter(input)).toBe("middle\n---\nsecond: block\n---\nend");
  });

  it("handles frontmatter with blank lines in YAML", () => {
    const input = "---\nkey1: val1\n\nkey2: val2\n---\nbody";
    expect(stripFrontmatter(input)).toBe("body");
  });

  it("returns body with no leading newline when body follows closing --- directly", () => {
    const input = "---\nkey: val\n---\nbody right after";
    expect(stripFrontmatter(input)).toBe("body right after");
  });

  it("strips frontmatter with sn_ prefixed fields (real-world example)", () => {
    const input = [
      "---",
      "sn_sys_id: abc123def456",
      "sn_category: kb_knowledge",
      "sn_project: My Project",
      "sn_tags: tag1, tag2",
      "sn_synced: true",
      "---",
      "# My Document",
      "",
      "This is the actual content.",
    ].join("\n");
    expect(stripFrontmatter(input)).toBe(
      "# My Document\n\nThis is the actual content."
    );
  });

  it("returns empty string when frontmatter is followed by only newlines", () => {
    const input = "---\nkey: val\n---\n\n\n";
    expect(stripFrontmatter(input)).toBe("");
  });
});
