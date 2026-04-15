import { describe, it, expect } from "vitest";
import { normalizeContent, contentHash, md5Hash } from "./content-hash";

describe("normalizeContent", () => {
  it("trims trailing whitespace per line", () => {
    expect(normalizeContent("hello   \nworld  ")).toBe("hello\nworld\n");
  });

  it("collapses multiple trailing newlines to one", () => {
    expect(normalizeContent("hello\nworld\n\n\n")).toBe("hello\nworld\n");
  });

  it("preserves leading whitespace", () => {
    expect(normalizeContent("  indented\n    more")).toBe("  indented\n    more\n");
  });

  it("handles empty string", () => {
    expect(normalizeContent("")).toBe("\n");
  });

  it("handles single newline", () => {
    expect(normalizeContent("\n")).toBe("\n");
  });

  it("handles content with no trailing whitespace", () => {
    expect(normalizeContent("clean\nlines")).toBe("clean\nlines\n");
  });
});

describe("normalizeContent with \\r\\n", () => {
  it("converts \\r\\n to \\n", () => {
    expect(normalizeContent("hello\r\nworld\r\n")).toBe("hello\nworld\n");
  });

  it("converts stray \\r to \\n", () => {
    expect(normalizeContent("hello\rworld\r")).toBe("hello\nworld\n");
  });

  it("handles mixed line endings", () => {
    expect(normalizeContent("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("normalizeContent spec vectors", () => {
  it("preserves frontmatter", () => {
    expect(normalizeContent("---\ndate: x\n---\nhello\n")).toBe("---\ndate: x\n---\nhello\n");
  });

  it("trims trailing whitespace and collapses newlines", () => {
    expect(normalizeContent("hello  \nworld\n\n\n")).toBe("hello\nworld\n");
  });

  it("normalizes \\r\\n", () => {
    expect(normalizeContent("hello\r\nworld\r\n")).toBe("hello\nworld\n");
  });

  it("passes through clean content", () => {
    expect(normalizeContent("no frontmatter\n")).toBe("no frontmatter\n");
  });

  it("preserves frontmatter with body gap", () => {
    expect(normalizeContent("---\ndate: x\n---\n\n\nbody\n")).toBe("---\ndate: x\n---\n\nbody\n");
  });
});

describe("md5Hash", () => {
  it("returns 32-char lowercase hex string", () => {
    const hash = md5Hash("hello\nworld\n");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces same hash for content differing only in trailing whitespace", () => {
    expect(md5Hash("hello  \nworld\n")).toBe(md5Hash("hello\nworld\n"));
  });

  it("produces same hash for content differing only in line endings", () => {
    expect(md5Hash("hello\r\nworld\r\n")).toBe(md5Hash("hello\nworld\n"));
  });

  it("produces same hash for content differing only in trailing newlines", () => {
    expect(md5Hash("hello\nworld\n\n\n")).toBe(md5Hash("hello\nworld\n"));
  });

  it("produces different hash for different content", () => {
    expect(md5Hash("hello\n")).not.toBe(md5Hash("world\n"));
  });
});

describe("contentHash", () => {
  it("returns same hash for identical content", () => {
    expect(contentHash("hello\nworld")).toBe(contentHash("hello\nworld"));
  });

  it("returns same hash when only trailing whitespace differs", () => {
    expect(contentHash("hello   \nworld  ")).toBe(contentHash("hello\nworld"));
  });

  it("returns same hash when trailing newlines differ", () => {
    expect(contentHash("hello\nworld\n\n\n")).toBe(contentHash("hello\nworld"));
  });

  it("returns different hash for different content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });

  it("returns a string", () => {
    expect(typeof contentHash("test")).toBe("string");
  });
});
