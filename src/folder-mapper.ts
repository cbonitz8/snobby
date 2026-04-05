import type { FolderMapping } from "./types";

export function resolveFilePath(
  mapping: FolderMapping,
  title: string,
  project: string,
  category: string,
  tag: string
): string {
  const filename = `${sanitizeTitle(title)}.md`;

  if (tag) {
    const custom = mapping.custom.find((c) => c.tag === tag);
    if (custom) {
      return `${custom.path}/${filename}`;
    }
  }

  const parts: string[] = [];

  if (mapping.projects && project) {
    parts.push(project);
  }

  if (category) {
    const catMapping = mapping.categories[category];
    if (catMapping) {
      if (typeof catMapping === "string") {
        parts.push(catMapping);
      } else {
        parts.push(catMapping.root);
        parts.push(catMapping.subfolders[0] ?? "");
      }
    }
  }

  parts.push(filename);
  return parts.filter((p) => p.length > 0).join("/");
}

export function sanitizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return "Untitled";
  return trimmed.replace(/[\\/:*?"<>|]/g, "-");
}
