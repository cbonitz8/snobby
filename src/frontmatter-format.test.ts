import { describe, it, expect } from "vitest";
import {
  splitFrontmatter,
  rebuild,
  replaceBody,
  filterPrefixedKeys,
  contentForPush,
  stripFrontmatter,
} from "./frontmatter-format";

// A representative document. The closing fence is followed by "\n" then body.
const DOC =
  "---\nsn_sys_id: abc\ntitle: Hello\nsn_synced: false\n---\n# Heading\n\nBody text\n";
// Inner YAML block (between the fences, no leading/trailing fence newlines).
const DOC_FM = "sn_sys_id: abc\ntitle: Hello\nsn_synced: false";
// Body: everything after the closing "---" fence — starts with the "\n".
const DOC_BODY = "\n# Heading\n\nBody text\n";

describe("splitFrontmatter", () => {
  it("splits a document into inner frontmatter and body", () => {
    expect(splitFrontmatter(DOC)).toEqual({ frontmatter: DOC_FM, body: DOC_BODY });
  });

  it.each([
    ["multi-line block", DOC],
    ["single-line block", "---\ntitle: X\n---\nbody\n"],
    ["block with no body", "---\ntitle: X\n---"],
  ])("round-trips a %s: rebuild(split) reproduces the original", (_label, doc) => {
    const { frontmatter, body } = splitFrontmatter(doc);
    expect(rebuild(frontmatter!, body)).toBe(doc);
  });

  it("returns null frontmatter and the whole string when there is no block", () => {
    const plain = "# Just a heading\n\nno frontmatter";
    expect(splitFrontmatter(plain)).toEqual({ frontmatter: null, body: plain });
  });

  it("treats an unterminated block as no frontmatter", () => {
    const bad = "---\nsn_sys_id: abc\nnever closed";
    expect(splitFrontmatter(bad)).toEqual({ frontmatter: null, body: bad });
  });

  it("returns empty-string frontmatter for an empty block", () => {
    expect(splitFrontmatter("---\n---\nbody")).toEqual({ frontmatter: "", body: "\nbody" });
  });
});

describe("replaceBody", () => {
  it("keeps the frontmatter block byte-for-byte and swaps the body", () => {
    expect(replaceBody(DOC, "new body")).toBe(
      "---\nsn_sys_id: abc\ntitle: Hello\nsn_synced: false\n---\nnew body",
    );
  });

  it("preserves an empty block verbatim (regression: no phantom blank lines)", () => {
    expect(replaceBody("---\n---\nold", "new")).toBe("---\n---\nnew");
  });

  it("returns the new body alone when there is no frontmatter", () => {
    expect(replaceBody("plain body", "new")).toBe("new");
  });

  it("returns the new body alone for an unterminated block", () => {
    expect(replaceBody("---\nnever closed", "new")).toBe("new");
  });
});

describe("rebuild", () => {
  it("wraps frontmatter in fences and appends the body verbatim", () => {
    expect(rebuild("a: 1", "\nbody")).toBe("---\na: 1\n---\nbody");
  });
});

describe("filterPrefixedKeys", () => {
  it("drops lines whose key starts with the prefix", () => {
    expect(filterPrefixedKeys(DOC_FM, "sn_")).toBe("title: Hello");
  });

  it("keeps all lines when none match the prefix", () => {
    expect(filterPrefixedKeys("title: Hello\nfoo: bar", "sn_")).toBe(
      "title: Hello\nfoo: bar",
    );
  });

  it("keeps non key:value lines (e.g. list items, blanks)", () => {
    const fm = "title: Hello\n  - listitem\nsn_tags: x";
    expect(filterPrefixedKeys(fm, "sn_")).toBe("title: Hello\n  - listitem");
  });
});

describe("contentForPush", () => {
  it("strips sn_ keys but keeps the frontmatter block when other keys remain", () => {
    expect(contentForPush(DOC, "sn_")).toBe("---\ntitle: Hello\n---\n# Heading\n\nBody text\n");
  });

  it("drops the whole block and leading newlines when only prefixed keys remain", () => {
    const onlySn = "---\nsn_sys_id: abc\nsn_synced: false\n---\n\nBody\n";
    expect(contentForPush(onlySn, "sn_")).toBe("Body\n");
  });

  it("returns the raw string unchanged when there is no frontmatter", () => {
    const plain = "no frontmatter here";
    expect(contentForPush(plain, "sn_")).toBe(plain);
  });
});

describe("stripFrontmatter", () => {
  it("removes the block and leading newlines from the body", () => {
    expect(stripFrontmatter(DOC)).toBe("# Heading\n\nBody text\n");
  });

  it("returns content unchanged when there is no frontmatter", () => {
    expect(stripFrontmatter("plain body")).toBe("plain body");
  });
});
