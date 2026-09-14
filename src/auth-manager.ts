import { Notice } from "obsidian";
import type SNSyncPlugin from "./main";
import type { AuthTokens } from "./types";
import { httpRequest, type HttpRequestOptions, type HttpResponse } from "./http";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const TOKEN_EXPIRY_BUFFER_MS = 60_000; // Refresh 1 minute before expiry

export class AuthManager {
  private plugin: SNSyncPlugin;
  private pendingOAuthState: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(
    plugin: SNSyncPlugin,
    private request: (options: HttpRequestOptions) => Promise<HttpResponse> = httpRequest
  ) {
    this.plugin = plugin;
  }

  get tokens(): AuthTokens {
    return this.plugin.authTokens;
  }

  isAuthenticated(): boolean {
    return this.tokens.refreshToken.length > 0;
  }

  startOAuthFlow() {
    const { instanceUrl, oauthClientId, oauthRedirectUri } = this.plugin.settings;

    if (!instanceUrl || !oauthClientId) {
      new Notice("Configure instance URL and OAuth client ID first.");
      return;
    }

    const redirectUri = oauthRedirectUri;
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    this.pendingOAuthState = state;

    const authUrl =
      `${instanceUrl}/oauth_auth.do` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(oauthClientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    window.open(authUrl);
  }

  async handleCallback(code: string, state?: string) {
    if (!this.pendingOAuthState || state !== this.pendingOAuthState) {
      new Notice("Authentication failed: invalid OAuth state. Try again.");
      this.pendingOAuthState = null;
      return;
    }
    this.pendingOAuthState = null;
    const { instanceUrl, oauthClientId, oauthClientSecret, oauthRedirectUri } = this.plugin.settings;

    try {
      const response = await this.request({
        url: `${instanceUrl}/oauth_token.do`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: oauthClientId,
          client_secret: oauthClientSecret,
          redirect_uri: oauthRedirectUri,
        }).toString(),
      });

      const data = response.json as TokenResponse;
      this.plugin.authTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      await this.plugin.saveSettings();
      new Notice("ServiceNow authentication successful!");
    } catch (e) {
      console.error("Snobby: OAuth token exchange failed", e instanceof Error ? e.message : "unknown error");
      new Notice("Authentication failed. Check your OAuth credentials.");
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    const { instanceUrl, oauthClientId, oauthClientSecret } = this.plugin.settings;

    try {
      const response = await this.request({
        url: `${instanceUrl}/oauth_token.do`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.tokens.refreshToken,
          client_id: oauthClientId,
          client_secret: oauthClientSecret,
        }).toString(),
      });

      const data = response.json as TokenResponse;
      this.plugin.authTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? this.tokens.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      await this.plugin.saveSettings();
      return true;
    } catch (e) {
      console.error("Snobby: Token refresh failed", e instanceof Error ? e.message : "unknown error");
      new Notice("ServiceNow session expired. Please re-authenticate.");
      return false;
    }
  }

  async authenticatedFetch(
    url: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; json: unknown } | null> {
    if (!this.isAuthenticated()) {
      new Notice("Not authenticated with ServiceNow.");
      return null;
    }

    if (Date.now() >= this.tokens.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) return null;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tokens.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    };

    try {
      const response = await this.request({
        url,
        method: options.method ?? "GET",
        headers,
        body: options.body,
      });
      return { status: response.status, json: response.json };
    } catch (e: unknown) {
      const err = e as { status?: number; json?: Record<string, unknown> };
      if (err.status === 401) {
        const refreshed = await this.refreshAccessToken();
        if (!refreshed) return null;
        headers.Authorization = `Bearer ${this.tokens.accessToken}`;
        const retry = await this.request({
          url,
          method: options.method ?? "GET",
          headers,
          body: options.body,
        });
        return { status: retry.status, json: retry.json };
      }
      if (err.status && err.json) {
        return { status: err.status, json: err.json };
      }
      throw e;
    }
  }
}
