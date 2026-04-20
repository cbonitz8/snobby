import type { FolderMapping } from "./types";

export function resolveFilePath(
  mapping: FolderMapping,
  title: string,
  project: string,
  category: string,
  tag: string,
  categoryLabel?: string
): string {
  const filename = `${sanitizeTitle(title)}.md`;

  if (tag) {
    const custom = mapping.custom.find((c) => c.tag === tag);
    if (custom) {
      return `${custom.path}/${filename}`;
    }
  }

  const parts: string[] = [];
  const catMapping = category ? mapping.categories[category] : undefined;
  const isTopLevel = catMapping && typeof catMapping !== "string" && catMapping.topLevel;

  if (mapping.projects && project && !isTopLevel) {
    parts.push(project);
  }

  if (catMapping) {
    if (typeof catMapping === "string") {
      parts.push(catMapping);
    } else {
      parts.push(catMapping.root);
      parts.push(catMapping.subfolders[0] ?? "");
    }
  } else if (category) {
    // Unmapped category: use metadata label if available, otherwise title-case the value
    parts.push(categoryLabel || toTitleCase(category));
  }

  parts.push(filename);
  return parts.filter((p) => p.length > 0).join("/");
}

/** Convert snake_case to Title Case (e.g. "story_time" → "Story Time") */
function toTitleCase(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function isTopLevelCategory(mapping: FolderMapping, category: string): boolean {
  const catMapping = mapping.categories[category];
  if (!catMapping) return false;
  return typeof catMapping !== "string" && catMapping.topLevel === true;
}

const MAX_PATH_SEGMENT = 200;
// Standard forbidden + Unicode slash/backslash lookalikes
const UNSAFE_PATH_CHARS = /[\\/:*?"<>|\u2215\uFF0F\uFF3C\u29F8\u29F9]/g;

export function sanitizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return "Untitled";
  return trimmed
    .replace(UNSAFE_PATH_CHARS, "-")
    .replace(/\.\./g, "")
    .replace(/^\.+/, "")
    .slice(0, MAX_PATH_SEGMENT);
}

export function sanitizePathSegment(segment: string): string {
  return (segment
    .replace(UNSAFE_PATH_CHARS, "-")
    .replace(/\.\./g, "")
    .replace(/^\.+/, "")
    .trim() || "unknown"
  ).slice(0, MAX_PATH_SEGMENT);
}
