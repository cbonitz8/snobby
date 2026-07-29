/**
 * Pure functions that own the YAML frontmatter *block format* — the split
 * between a `---`-delimited frontmatter block and the document body, and the
 * rebuild back into a document. No Obsidian dependency, so every module
 * (sync engine, conflict resolver, frontmatter manager) can share one
 * definition of "where does the body start" instead of hand-rolling
 * `raw.indexOf("\n---", 3)` at each site.
 */

const KEY_REGEX = /^(\S+)\s*:/;

export interface FrontmatterSplit {
  /** Inner YAML between the fences (no leading `---\n`, no trailing `\n---`), or null when absent. */
  frontmatter: string | null;
  /** Everything after the closing `---` fence, including its leading newline; or the whole string when no block. */
  body: string;
}

/**
 * Split a document into its inner frontmatter block and body.
 * A document with no leading `---`, or an unterminated block, yields
 * `{ frontmatter: null, body: raw }`. An empty block (`---\n---`) yields an
 * empty-string frontmatter.
 *
 * Note: this is a *lossy* split for reconstruction — a zero-line block can't
 * be rebuilt fence-for-fence from the inner string. Use {@link replaceBody}
 * when you need to swap the body while keeping the original block verbatim.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit {
  if (!raw.startsWith("---")) return { frontmatter: null, body: raw };
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return { frontmatter: null, body: raw };
  return {
    frontmatter: endIdx < 4 ? "" : raw.substring(4, endIdx),
    body: raw.slice(endIdx + 4),
  };
}

/** Inverse of {@link splitFrontmatter} for non-empty blocks: wrap inner YAML in fences and append the body verbatim. */
export function rebuild(frontmatter: string, body: string): string {
  return "---\n" + frontmatter + "\n---" + body;
}

/**
 * Replace a document's body while keeping its frontmatter block byte-for-byte.
 * When there is no frontmatter block, returns `newBody` alone. `newBody` is
 * appended after the closing fence with a single separating newline.
 */
export function replaceBody(raw: string, newBody: string): string {
  if (!raw.startsWith("---")) return newBody;
  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) return newBody;
  return raw.substring(0, endIdx + 4) + "\n" + newBody;
}

/** Drop YAML lines whose key starts with `prefix`; keep non `key:value` lines untouched. */
export function filterPrefixedKeys(frontmatter: string, prefix: string): string {
  return frontmatter
    .split("\n")
    .filter((line) => {
      const match = line.match(KEY_REGEX);
      if (!match) return true;
      return !match[1]!.startsWith(prefix);
    })
    .join("\n");
}

/**
 * The content to send to ServiceNow / hash for optimistic locking: the body
 * plus any non-prefixed frontmatter. Prefixed (`sn_`) keys are stripped so
 * plugin-managed fields never affect the content hash. When no non-prefixed
 * keys remain, the frontmatter block is dropped entirely.
 */
export function contentForPush(raw: string, prefix: string): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) return raw;

  const filtered = filterPrefixedKeys(frontmatter, prefix);
  const hasContent = filtered.split("\n").some((line) => line.trim().length > 0);
  if (!hasContent) return body.replace(/^\n+/, "");

  return rebuild(filtered, body);
}

/** The document body with the frontmatter block and its leading newlines removed. */
export function stripFrontmatter(content: string): string {
  const { frontmatter, body } = splitFrontmatter(content);
  return frontmatter === null ? body : body.replace(/^\n+/, "");
}
