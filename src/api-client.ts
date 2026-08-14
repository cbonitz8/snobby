import type { AuthManager } from "./auth-manager";
import type { SNDocument, SNMetadata, SNUserInfo, CreateDocumentPayload, UpdateDocumentPayload } from "./types";

interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

export class ApiClient {
  /** Documents fetched per request by {@link getDocuments}. */
  private static readonly PAGE_SIZE = 500;
  /** Hard stop on paging, so a server that ignores `offset` can't loop forever. */
  private static readonly MAX_PAGES = 100;

  private authManager: AuthManager;
  private instanceUrl: string;
  private apiPath: string;
  private metadataPath: string;

  constructor(authManager: AuthManager, instanceUrl: string, apiPath: string, metadataPath: string) {
    this.authManager = authManager;
    this.instanceUrl = instanceUrl;
    this.apiPath = apiPath;
    this.metadataPath = metadataPath;
  }

  updateConfig(instanceUrl: string, apiPath: string, metadataPath: string) {
    this.instanceUrl = instanceUrl;
    this.apiPath = apiPath;
    this.metadataPath = metadataPath;
  }

  private url(path: string): string {
    return `${this.instanceUrl}${this.apiPath}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResponse<T>> {
    try {
      const response = await this.authManager.authenticatedFetch(this.url(path), {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response) {
        return { ok: false, status: 0, data: null };
      }

      const json = response.json as Record<string, unknown>;
      // SN scripted REST wraps in { result: ... }. If the script also uses
      // response.setBody({ result: ... }), we get double-nesting: { result: { result: ... } }
      let data = json.result as T;
      if (data && typeof data === "object" && "result" in (data as Record<string, unknown>)) {
        data = (data as Record<string, unknown>).result as T;
      }
      return { ok: response.status >= 200 && response.status < 300, status: response.status, data };
    } catch (e: unknown) {
      const err = e as { status?: number };
      return { ok: false, status: err.status ?? 0, data: null };
    }
  }

  /**
   * Fetch every document, paging through the collection endpoint.
   *
   * The server caps each response, so a single request returns a partial list.
   * Callers (initialPull, discoverNewDocs, findExistingServerDoc) treat the
   * result as the complete server state, so a short read must surface as an
   * error rather than as fewer documents.
   */
  async getDocuments(): Promise<ApiResponse<SNDocument[]>> {
    const all: SNDocument[] = [];
    let offset = 0;

    for (let page = 0; page < ApiClient.MAX_PAGES; page++) {
      const response = await this.request<SNDocument[]>(
        "GET",
        `/documents?limit=${ApiClient.PAGE_SIZE}&offset=${offset}`
      );

      if (!response.ok || !response.data) {
        return { ok: false, status: response.status, data: null };
      }

      const docs = Array.isArray(response.data) ? response.data : [response.data];
      all.push(...docs);

      if (docs.length < ApiClient.PAGE_SIZE) {
        return { ok: true, status: response.status, data: all };
      }
      offset += ApiClient.PAGE_SIZE;
    }

    // Only reachable if the server keeps returning full pages — e.g. an
    // un-upgraded endpoint ignoring `offset`. Refuse rather than return a list
    // built from the same page repeated.
    return { ok: false, status: 0, data: null };
  }

  async getDocument(id: string): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("GET", `/documents/${encodeURIComponent(id)}`);
  }

  async getChanges(since: string): Promise<ApiResponse<SNDocument[]>> {
    return this.request<SNDocument[]>("GET", `/documents/changes?since=${encodeURIComponent(since)}`);
  }

  async createDocument(doc: CreateDocumentPayload): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("POST", "/documents", doc);
  }

  async updateDocument(
    id: string,
    doc: UpdateDocumentPayload
  ): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("PUT", `/documents/${encodeURIComponent(id)}`, doc);
  }

  async deleteDocument(id: string): Promise<ApiResponse<void>> {
    return this.request<void>("DELETE", `/documents/${encodeURIComponent(id)}`);
  }

  async getUser(sysId: string): Promise<ApiResponse<SNUserInfo>> {
    return this.request<SNUserInfo>("GET", `/user/${encodeURIComponent(sysId)}`);
  }

  async getMetadata(): Promise<ApiResponse<SNMetadata>> {
    return this.request<SNMetadata>("GET", this.metadataPath);
  }
}
