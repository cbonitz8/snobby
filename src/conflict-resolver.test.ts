import { describe, it, expect } from "vitest";
import { hasConflictMarkers, stripConflictMarkers } from "./conflict-resolver";

describe("hasConflictMarkers", () => {
  it("detects conflict markers", () => {
    const content = "some text\n<<<<<<< Local (Obsidian)\nfoo\n=======\nbar\n>>>>>>> Remote (ServiceNow)\nmore text";
    expect(hasConflictMarkers(content)).toBe(true);
  });

  it("returns false for clean content", () => {
    expect(hasConflictMarkers("just normal text")).toBe(false);
  });
});

describe("stripConflictMarkers", () => {
  it("extracts local portion from conflicted content", () => {
    const conflicted = "<<<<<<< Local (Obsidian)\nmy local text\n=======\nremote text\n>>>>>>> Remote (ServiceNow)";
    expect(stripConflictMarkers(conflicted)).toBe("my local text");
  });

  it("preserves surrounding content", () => {
    const conflicted = "before\n<<<<<<< Local (Obsidian)\nlocal\n=======\nremote\n>>>>>>> Remote (ServiceNow)\nafter";
    expect(stripConflictMarkers(conflicted)).toBe("before\nlocal\nafter");
  });

  it("returns content unchanged if no markers present", () => {
    expect(stripConflictMarkers("just normal text")).toBe("just normal text");
  });

  it("strips outermost markers from nested content", () => {
    const nested = "<<<<<<< Local (Obsidian)\n<<<<<<< Local (Obsidian)\ninner\n=======\ninner remote\n>>>>>>> Remote (ServiceNow)\n=======\nouter remote\n>>>>>>> Remote (ServiceNow)";
    const result = stripConflictMarkers(nested);
    const secondPass = stripConflictMarkers(result);
    expect(hasConflictMarkers(secondPass)).toBe(false);
  });
});
