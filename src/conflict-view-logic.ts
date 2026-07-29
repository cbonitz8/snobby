import { extractChangeGroups, type DiffLine } from "./diff";

/**
 * Pure, DOM-free logic extracted from the Snobby browser view so it can be
 * tested through its interface instead of only through the Obsidian runtime.
 */

/**
 * Seed per-line merge defaults for a conflicting section, in place. Only fills
 * indices not already chosen by the user. Within an overlapping change (both
 * sides edited), removed lines default to included and added lines to excluded;
 * a one-sided change defaults to included.
 */
export function seedLineChoices(diffLines: DiffLine[], choices: Map<number, boolean>): void {
  for (const cg of extractChangeGroups(diffLines)) {
    for (let idx = cg.startLine; idx <= cg.endLine; idx++) {
      if (choices.has(idx)) continue;
      const line = diffLines[idx]!;
      if (cg.hasLocal && cg.hasRemote) {
        choices.set(idx, line.type === "removed");
      } else {
        choices.set(idx, true);
      }
    }
  }
}

export interface ButtonState {
  isAllLocal: boolean;
  isAllRemote: boolean;
  isAllBoth: boolean;
}

/**
 * Which of the "All local / All remote / Include both" quick actions the
 * current per-line choices already satisfy (for highlighting the active one).
 */
export function buttonState(diffLines: DiffLine[], choices: Map<number, boolean>): ButtonState {
  const allRemovedTrue = diffLines.every((l, i) => l.type !== "removed" || choices.get(i) === true);
  const allAddedFalse = diffLines.every((l, i) => l.type !== "added" || choices.get(i) === false);
  const allRemovedFalse = diffLines.every((l, i) => l.type !== "removed" || choices.get(i) === false);
  const allAddedTrue = diffLines.every((l, i) => l.type !== "added" || choices.get(i) === true);
  const allNonCtxTrue = diffLines.every((l, i) => l.type === "context" || choices.get(i) === true);
  return {
    isAllLocal: allRemovedTrue && allAddedFalse,
    isAllRemote: allRemovedFalse && allAddedTrue,
    isAllBoth: allNonCtxTrue,
  };
}

export interface DocFilters {
  project: string;
  category: string;
  status: string;
  search: string;
}

/** Filter server documents by the browser's project/category/status/search selectors. */
export function filterDocs<T extends { project: string; category: string; title: string }>(
  docs: T[],
  filters: DocFilters,
  statusOf: (doc: T) => string,
): T[] {
  return docs.filter((doc) => {
    if (filters.project && doc.project !== filters.project) return false;
    if (filters.category && doc.category !== filters.category) return false;
    if (filters.status && filters.status !== statusOf(doc)) return false;
    if (filters.search && !doc.title.toLowerCase().includes(filters.search.toLowerCase())) return false;
    return true;
  });
}

/** A tracked document is `synced` only when it has a docMap entry AND its local file exists. */
export function docStatus(hasEntry: boolean, fileExists: boolean): "not-downloaded" | "synced" {
  return hasEntry && fileExists ? "synced" : "not-downloaded";
}
