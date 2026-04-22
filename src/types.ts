export interface SNDocument {
  sys_id: string;
  title: string;
  content: string;
  category: string;
  project: string;
  tags: string;
  sys_updated_on: string;
  content_hash: string;
}

export interface SNMetadata {
  categories: { value: string; label: string }[];
  projects: { value: string; label: string }[];
  tags: string[];
}

export interface SNUserInfo {
  sys_id: string;
  name: string;
  user_name: string;
}

export interface DocMapEntry {
  sysId: string;
  path: string;
  lastServerTimestamp: string;
  contentHash: string;
  localContentHash?: string;
  lastSyncMtime?: number;
}

export interface ConflictEntry {
  sysId: string;
  path: string;
  remoteContent: string;
  remoteTimestamp: string;
  sectionConflicts?: SectionConflict[];
  ancestorContent?: string;
}

export type CreateDocumentPayload = Pick<SNDocument, "title" | "content" | "category" | "project" | "tags">;
export type UpdateDocumentPayload = Partial<CreateDocumentPayload> & { expected_hash?: string };

export interface ConflictResponseData {
  conflict: boolean;
  content_hash: string;
  content: string;
  sys_updated_on: string;
  ancestor_content: string | null;
}

export interface SyncState {
  lastSyncTimestamp: string;
  ignoredIds: string[];
  docMap: Record<string, DocMapEntry>;
  conflicts: Record<string, ConflictEntry>;
}

export interface SNFrontmatter {
  sys_id?: string;
  category?: string;
  project?: string;
  tags?: string;
  synced?: boolean;
}

export type CategoryMapping = string | {
  root: string;
  subfolders: string[];
  topLevel?: boolean;
};

export interface CustomFolderMapping {
  path: string;
  tag: string;
}

export interface FolderMapping {
  projects: boolean;
  categories: Record<string, CategoryMapping>;
  custom: CustomFolderMapping[];
}

export type SyncMode = "interval" | "manual";

export type LocalDeleteBehavior = "ignore" | "re-pull" | "archive";

export type RemoteDeleteBehavior = "delete local" | "keep local";

export interface SNSyncSettings {
  instanceUrl: string;
  apiPath: string;
  metadataPath: string;
  oauthRedirectUri: string;
  oauthClientId: string;
  oauthClientSecret: string;
  syncMode: SyncMode;
  syncIntervalSeconds: number;
  frontmatterPrefix: string;
  localDeleteBehavior: LocalDeleteBehavior;
  remoteDeleteBehavior: RemoteDeleteBehavior;
  folderMapping: FolderMapping;
  excludePaths: string[];
  userSysId: string;
  userDisplayName: string;
  vaultName: string;
  vaultPath: string;
}

export interface PluginData {
  settings: SNSyncSettings;
  syncState: SyncState;
  auth?: AuthTokens; // Legacy — tokens now stored in localStorage
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  errors: string[];
}

export interface SectionBlock {
  heading: string;
  key: string;
  body: string;
  hash: string;
}

export interface SectionConflict {
  key: string;
  heading: string;
  localBody: string;
  remoteBody: string;
  baseBody: string | null;
}

export type SectionOutcome =
  | { status: "unchanged" }
  | { status: "accepted_remote"; body: string }
  | { status: "kept_local"; body: string }
  | { status: "added"; source: "local" | "remote"; body: string }
  | { status: "deleted"; source: "local" | "remote" }
  | { status: "conflict"; conflict: SectionConflict };

export interface MergeResult {
  mergedBody: string;
  outcomes: Map<string, SectionOutcome>;
  conflicts: SectionConflict[];
  hasConflicts: boolean;
}
