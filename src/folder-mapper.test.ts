import { describe, it, expect } from "vitest";
import { resolveFilePath, sanitizeTitle, isTopLevelCategory } from "./folder-mapper";
import type { FolderMapping } from "./types";

const MAPPING: FolderMapping = {
  projects: true,
  categories: {
    session_log: "Session Logs",
    design_spec: "Design Specs",
    project_overview: "Project Overviews",
    qa_document: {
      root: "QA",
      subfolders: ["In Progress", "Complete"],
    },
    daily_log: { root: "Daily Logs", subfolders: [], topLevel: true },
    standup: { root: "Standups", subfolders: [], topLevel: true },
    reference: { root: "Resources", subfolders: ["Components"], topLevel: true },
  },
  custom: [
    { path: "Resources/Reusable Components/Widgets", tag: "widget" },
  ],
};

describe("resolveFilePath", () => {
  it("places doc with project + category", () => {
    const result = resolveFilePath(MAPPING, "My Doc", "Project Alpha", "session_log", "");
    expect(result).toBe("Project Alpha/Session Logs/My Doc.md");
  });

  it("places doc with project only", () => {
    const result = resolveFilePath(MAPPING, "My Doc", "Project Alpha", "", "");
    expect(result).toBe("Project Alpha/My Doc.md");
  });

  it("places doc with category only", () => {
    const result = resolveFilePath(MAPPING, "My Doc", "", "design_spec", "");
    expect(result).toBe("Design Specs/My Doc.md");
  });

  it("places doc with neither at vault root", () => {
    const result = resolveFilePath(MAPPING, "My Doc", "", "", "");
    expect(result).toBe("My Doc.md");
  });

  it("places QA doc in root subfolder when no status specified", () => {
    const result = resolveFilePath(MAPPING, "Audit Review", "", "qa_document", "");
    expect(result).toBe("QA/In Progress/Audit Review.md");
  });

  it("uses custom tag mapping when tag matches", () => {
    const result = resolveFilePath(MAPPING, "eg-select", "", "", "widget");
    expect(result).toBe("Resources/Reusable Components/Widgets/eg-select.md");
  });

  it("places topLevel category at vault root even with a project", () => {
    const result = resolveFilePath(MAPPING, "Import notes", "Acme App", "daily_log", "");
    expect(result).toBe("Daily Logs/Import notes.md");
  });

  it("places standup at vault root ignoring project", () => {
    const result = resolveFilePath(MAPPING, "Standup", "Acme Portal", "standup", "");
    expect(result).toBe("Standups/Standup.md");
  });

  it("places reference doc in Resources/Components at vault root", () => {
    const result = resolveFilePath(MAPPING, "Widget Table", "Acme Portal", "reference", "");
    expect(result).toBe("Resources/Components/Widget Table.md");
  });

  it("places project overview in Project Overviews subfolder", () => {
    const result = resolveFilePath(MAPPING, "Acme Portal Overview", "Acme Portal", "project_overview", "");
    expect(result).toBe("Acme Portal/Project Overviews/Acme Portal Overview.md");
  });

  it("uses metadata label for unmapped category", () => {
    const result = resolveFilePath(MAPPING, "My Story", "Story Time", "story_time", "", "Story Time");
    expect(result).toBe("Story Time/Story Time/My Story.md");
  });

  it("title-cases unmapped category when no label provided", () => {
    const result = resolveFilePath(MAPPING, "My Story", "", "story_time", "");
    expect(result).toBe("Story Time/My Story.md");
  });

  it("title-cases multi-word unmapped category", () => {
    const result = resolveFilePath(MAPPING, "Doc", "", "team_retrospective", "");
    expect(result).toBe("Team Retrospective/Doc.md");
  });
});

describe("sanitizeTitle", () => {
  it("removes filesystem-unsafe characters", () => {
    expect(sanitizeTitle("My Doc: A/B Test")).toBe("My Doc- A-B Test");
  });

  it("trims whitespace", () => {
    expect(sanitizeTitle("  hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(sanitizeTitle("")).toBe("Untitled");
  });
});

describe("isTopLevelCategory", () => {
  it("returns true for topLevel categories", () => {
    expect(isTopLevelCategory(MAPPING, "daily_log")).toBe(true);
    expect(isTopLevelCategory(MAPPING, "standup")).toBe(true);
    expect(isTopLevelCategory(MAPPING, "reference")).toBe(true);
  });

  it("returns false for project-scoped categories", () => {
    expect(isTopLevelCategory(MAPPING, "session_log")).toBe(false);
    expect(isTopLevelCategory(MAPPING, "design_spec")).toBe(false);
    expect(isTopLevelCategory(MAPPING, "project_overview")).toBe(false);
  });

  it("returns false for unknown categories", () => {
    expect(isTopLevelCategory(MAPPING, "nonexistent")).toBe(false);
  });
});
