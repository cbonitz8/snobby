import { Notice, requestUrl } from "obsidian";
import type SNSyncPlugin from "./main";
import type { AuthTokens } from "./types";

const TOKEN_EXPIRY_BUFFER_MS = 60_000; // Refresh 1 minute before expiry

export class AuthManager {
  private plugin: SNSyncPlugin;

  constructor(plugin: SNSyncPlugin) {
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
      new Notice("Configure Instance URL and OAuth Client ID first.");
      return;
    }

    const redirectUri = oauthRedirectUri;
    const authUrl =
      `${instanceUrl}/oauth_auth.do` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(oauthClientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=sn-obsidian-sync`;

    window.open(authUrl);
  }

  async handleCallback(code: string) {
    const { instanceUrl, oauthClientId, oauthClientSecret, oauthRedirectUri } = this.plugin.settings;

    try {
      const response = await requestUrl({
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

      const data = response.json;
      this.plugin.authTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      await this.plugin.saveSettings();
      new Notice("ServiceNow authentication successful!");
    } catch (e) {
      console.error("Snobby: OAuth token exchange failed", e);
      new Notice("Authentication failed. Check your OAuth credentials.");
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    const { instanceUrl, oauthClientId, oauthClientSecret } = this.plugin.settings;

    try {
      const response = await requestUrl({
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

      const data = response.json;
      this.plugin.authTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? this.tokens.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      await this.plugin.saveSettings();
      return true;
    } catch (e) {
      console.error("Snobby: Token refresh failed", e);
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
      const response = await requestUrl({
        url,
        method: options.method ?? "GET",
        headers,
        body: options.body,
      });
      return { status: response.status, json: response.json };
    } catch (e: unknown) {
      const err = e as { status?: number };
      if (err.status === 401) {
        const refreshed = await this.refreshAccessToken();
        if (!refreshed) return null;
        headers.Authorization = `Bearer ${this.tokens.accessToken}`;
        const retry = await requestUrl({
          url,
          method: options.method ?? "GET",
          headers,
          body: options.body,
        });
        return { status: retry.status, json: retry.json };
      }
      throw e;
    }
  }
}
