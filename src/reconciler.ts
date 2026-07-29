import type { SectionConflict } from "./types";
import { parseSections } from "./section-parser";
import { mergeSections } from "./section-merger";

/**
 * The decision an auto-reconcile site must act on. The Reconciler makes the
 * decision; the caller performs the I/O it names.
 *
 * - `no-change`      — server content is unchanged since last sync; nothing to write.
 * - `overwrite-local`— server changed and local is clean; take the remote wholesale.
 * - `auto-merged`    — both sides changed but three-way merge resolved cleanly.
 * - `conflict`       — both sides changed and sections truly conflict.
 */
export type ReconcileOutcome =
  | { kind: "no-change" }
  | { kind: "overwrite-local" }
  | { kind: "auto-merged"; mergedBody: string }
  | { kind: "conflict"; sectionConflicts: SectionConflict[] };

export interface ReconcileInput {
  /** Local document body, frontmatter already stripped. */
  localBody: string;
  /** Remote document body, frontmatter already stripped. */
  remoteBody: string;
  /** Ancestor from the server 409 body (stripped), or null. Preferred over the cache. */
  serverAncestor: string | null;
  /** Ancestor from the local base cache, or null. Used only when there is no server ancestor. */
  cachedAncestor: string | null;
  /** Server's current content hash (pull); when it equals `storedContentHash` the server is unchanged. */
  remoteContentHash?: string;
  /** Content hash recorded at the last successful sync. */
  storedContentHash?: string;
  /** Hash of the last-synced local content, or undefined for legacy entries. */
  storedLocalHash?: string;
  /** Freshly computed hash of the current local content (pull). */
  localHash?: string;
  /** Push shortcut: the caller already established that local diverged (the server rejected its hash). */
  localAlreadyDiverged?: boolean;
}

/**
 * Decide how a pulled document, or a 409 push response, should reconcile with
 * the local file. Owns ancestor precedence (server over cache) and the full
 * detect-then-merge decision. Pure — no I/O, no Obsidian dependency.
 */
export function reconcile(input: ReconcileInput): ReconcileOutcome {
  const serverUnchanged = Boolean(
    input.remoteContentHash && input.remoteContentHash === input.storedContentHash,
  );
  if (serverUnchanged) return { kind: "no-change" };

  if (!hasLocalDiverged(input)) return { kind: "overwrite-local" };

  const ancestor = input.serverAncestor ?? input.cachedAncestor ?? null;
  const merge = mergeSections(
    ancestor ? parseSections(ancestor) : null,
    parseSections(input.localBody),
    parseSections(input.remoteBody),
  );
  if (!merge.hasConflicts) return { kind: "auto-merged", mergedBody: merge.mergedBody };
  return { kind: "conflict", sectionConflicts: merge.conflicts };
}

/**
 * Has the local file changed since the last sync? Modern entries compare the
 * fresh local hash against the stored one; legacy entries with no stored hash
 * fall back to the cached ancestor body, then to a direct local-vs-remote
 * comparison.
 */
function hasLocalDiverged(input: ReconcileInput): boolean {
  if (input.localAlreadyDiverged) return true;
  if (input.storedLocalHash !== undefined) return input.localHash !== input.storedLocalHash;
  if (input.cachedAncestor !== null) return input.localBody !== input.cachedAncestor;
  return input.localBody !== input.remoteBody;
}
