import type { SectionBlock } from "./types";
import { contentHash } from "./content-hash";

const H3_REGEX = /^### .+/;
const PREAMBLE_KEY = "__preamble";

/**
 * Parse markdown body (no frontmatter) into h3-delimited sections.
 * Content before the first ### heading is stored under key "__preamble".
 */
export function parseSections(body: string): Map<string, SectionBlock> {
  const sections = new Map<string, SectionBlock>();
  if (!body || !body.trim()) return sections;

  const lines = body.split("\n");
  const keyCounts = new Map<string, number>();

  let currentKey: string | null = null;
  let currentHeading = "";
  let currentLines: string[] = [];

  function flush(trailingNewline: boolean) {
    if (currentKey === null && currentLines.length === 0) return;

    const key = currentKey ?? PREAMBLE_KEY;
    if (trailingNewline && (currentLines.length === 0 || currentLines[currentLines.length - 1] !== "")) {
      currentLines.push("");
    }
    const rawBody = currentLines.join("\n");
    const heading = currentHeading;

    const finalKey = deduplicateKey(key, keyCounts);
    sections.set(finalKey, {
      heading,
      key: finalKey,
      body: rawBody,
      hash: contentHash(rawBody),
    });
  }

  for (const line of lines) {
    if (H3_REGEX.test(line)) {
      flush(true);
      currentKey = line.replace(/^###\s+/, "").trim().toLowerCase();
      currentHeading = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush(false);

  return sections;
}

function deduplicateKey(
  key: string,
  counts: Map<string, number>,
): string {
  const count = counts.get(key) ?? 0;
  counts.set(key, count + 1);
  return count === 0 ? key : `${key}-${count + 1}`;
}

/**
 * Reconstruct markdown body from section map.
 * Preamble first (if present), then sections in map order.
 */
export function serializeSections(
  sections: Map<string, SectionBlock>,
): string {
  const parts: string[] = [];

  for (const [key, section] of sections) {
    if (key === PREAMBLE_KEY || key.startsWith(PREAMBLE_KEY)) {
      parts.push(section.body);
    } else {
      parts.push(section.heading + "\n" + section.body);
    }
  }

  return parts.join("\n");
}
