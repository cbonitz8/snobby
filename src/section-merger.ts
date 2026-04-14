import type { SectionBlock, SectionConflict, SectionOutcome, MergeResult } from "./types";
import { serializeSections } from "./section-parser";

/**
 * Three-way section-level merge. Compares base/local/remote section maps
 * and produces a merged result with per-section outcomes.
 *
 * If base is null, falls back to two-way merge (no deletion detection).
 */
export function mergeSections(
  base: Map<string, SectionBlock> | null,
  local: Map<string, SectionBlock>,
  remote: Map<string, SectionBlock>,
): MergeResult {
  const allKeys = new Set<string>();
  if (base) for (const k of base.keys()) allKeys.add(k);
  for (const k of local.keys()) allKeys.add(k);
  for (const k of remote.keys()) allKeys.add(k);

  const outcomes = new Map<string, SectionOutcome>();
  const conflicts: SectionConflict[] = [];
  const merged = new Map<string, SectionBlock>();

  for (const key of allKeys) {
    const baseSection = base?.get(key) ?? null;
    const localSection = local.get(key) ?? null;
    const remoteSection = remote.get(key) ?? null;

    const outcome = base
      ? resolveThreeWay(key, baseSection, localSection, remoteSection)
      : resolveTwoWay(key, localSection, remoteSection);

    outcomes.set(key, outcome);

    if (outcome.status === "conflict") {
      conflicts.push(outcome.conflict);
      if (localSection) merged.set(key, localSection);
    } else if (outcome.status === "deleted") {
      // Omit from merged output
    } else if (outcome.status === "unchanged") {
      const section = localSection ?? remoteSection;
      if (section) merged.set(key, section);
    } else if (outcome.status === "accepted_remote") {
      if (remoteSection) merged.set(key, remoteSection);
    } else if (outcome.status === "kept_local") {
      if (localSection) merged.set(key, localSection);
    } else if (outcome.status === "added") {
      const section = outcome.source === "local" ? localSection : remoteSection;
      if (section) merged.set(key, section);
    }
  }

  return {
    mergedBody: serializeSections(merged),
    outcomes,
    conflicts,
    hasConflicts: conflicts.length > 0,
  };
}

function resolveThreeWay(
  key: string,
  base: SectionBlock | null,
  local: SectionBlock | null,
  remote: SectionBlock | null,
): SectionOutcome {
  const baseHash = base?.hash ?? null;
  const localHash = local?.hash ?? null;
  const remoteHash = remote?.hash ?? null;

  // Section exists in base
  if (baseHash !== null) {
    if (localHash === null && remoteHash === null) {
      return { status: "deleted", source: "local" };
    }
    if (localHash === null) {
      return { status: "deleted", source: "local" };
    }
    if (remoteHash === null) {
      return { status: "deleted", source: "remote" };
    }
    if (localHash === baseHash && remoteHash === baseHash) {
      return { status: "unchanged" };
    }
    if (localHash === baseHash && remoteHash !== baseHash) {
      return { status: "accepted_remote", body: remote!.body };
    }
    if (localHash !== baseHash && remoteHash === baseHash) {
      return { status: "kept_local", body: local!.body };
    }
    if (localHash === remoteHash) {
      return { status: "unchanged" }; // convergent
    }
    return {
      status: "conflict",
      conflict: {
        key,
        heading: local!.heading || remote!.heading,
        localBody: local!.body,
        remoteBody: remote!.body,
        baseBody: base!.body,
      },
    };
  }

  // Section not in base — new addition
  if (localHash !== null && remoteHash === null) {
    return { status: "added", source: "local", body: local!.body };
  }
  if (localHash === null && remoteHash !== null) {
    return { status: "added", source: "remote", body: remote!.body };
  }
  if (localHash !== null && remoteHash !== null) {
    if (localHash === remoteHash) {
      return { status: "added", source: "local", body: local!.body };
    }
    return {
      status: "conflict",
      conflict: {
        key,
        heading: local!.heading || remote!.heading,
        localBody: local!.body,
        remoteBody: remote!.body,
        baseBody: null,
      },
    };
  }

  return { status: "unchanged" };
}

function resolveTwoWay(
  key: string,
  local: SectionBlock | null,
  remote: SectionBlock | null,
): SectionOutcome {
  const localHash = local?.hash ?? null;
  const remoteHash = remote?.hash ?? null;

  if (localHash === remoteHash) {
    return { status: "unchanged" };
  }
  if (localHash !== null && remoteHash === null) {
    return { status: "kept_local", body: local!.body };
  }
  if (localHash === null && remoteHash !== null) {
    return { status: "accepted_remote", body: remote!.body };
  }
  return {
    status: "conflict",
    conflict: {
      key,
      heading: local!.heading || remote!.heading,
      localBody: local!.body,
      remoteBody: remote!.body,
      baseBody: null,
    },
  };
}
