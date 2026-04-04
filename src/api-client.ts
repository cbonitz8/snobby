import type { AuthManager } from "./auth-manager";
import type { SNDocument, SNMetadata } from "./types";

interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

export class ApiClient {
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
      console.log(`Snobby API [${method} ${path}]:`, JSON.stringify(json).slice(0, 500));
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

  async getDocuments(): Promise<ApiResponse<SNDocument[]>> {
    return this.request<SNDocument[]>("GET", "/documents");
  }

  async getDocument(id: string): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("GET", `/documents/${id}`);
  }

  async getChanges(since: string): Promise<ApiResponse<SNDocument[]>> {
    return this.request<SNDocument[]>("GET", `/documents/changes?since=${encodeURIComponent(since)}`);
  }

  async createDocument(doc: {
    title: string;
    content: string;
    category: string;
    project: string;
    tags: string;
  }): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("POST", "/documents", doc);
  }

  async updateDocument(
    id: string,
    doc: { title?: string; content?: string; category?: string; project?: string; tags?: string }
  ): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("PUT", `/documents/${id}`, doc);
  }

  async deleteDocument(id: string): Promise<ApiResponse<void>> {
    return this.request<void>("DELETE", `/documents/${id}`);
  }

  async checkout(id: string): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("POST", `/documents/${id}/checkout`);
  }

  async checkin(id: string): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("POST", `/documents/${id}/checkin`);
  }

  async forceCheckin(id: string): Promise<ApiResponse<SNDocument>> {
    return this.request<SNDocument>("POST", `/documents/${id}/force-checkin`);
  }

  async getMetadata(): Promise<ApiResponse<SNMetadata>> {
    return this.request<SNMetadata>("GET", this.metadataPath);
  }
}
