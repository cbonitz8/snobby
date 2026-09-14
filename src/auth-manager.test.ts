import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { AuthManager } from "./auth-manager";
import { httpRequest } from "./http";
import type SNSyncPlugin from "./main";
import type { AuthTokens } from "./types";

let server: http.Server | null = null;

/** Starts a real loopback server, recording every request it receives. */
async function serve(
  handler: http.RequestListener
): Promise<{ base: string; requests: { method?: string; url?: string; body: string }[] }> {
  const requests: { method?: string; url?: string; body: string }[] = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return { base: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
});

function pluginWith(tokens: Partial<AuthTokens>, instanceUrl: string): SNSyncPlugin {
  return {
    settings: {
      instanceUrl,
      oauthClientId: "client-1",
      oauthClientSecret: "secret-1",
      oauthRedirectUri: "obsidian://ethos-md-sync/callback",
    },
    authTokens: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 600_000,
      ...tokens,
    },
    saveSettings: async () => {},
  } as unknown as SNSyncPlugin;
}

/** Node transport, standing in for the https default the plugin uses at runtime. */
function nodeTransport(options: Parameters<typeof httpRequest>[0]) {
  return httpRequest(options, http.request);
}

describe("AuthManager", () => {
  it("sends authenticated requests over the injected transport", async () => {
    const { base, requests } = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "ok" }));
    });
    const auth = new AuthManager(pluginWith({}, base), nodeTransport);

    const response = await auth.authenticatedFetch(`${base}/api/etgr/eg_docs`);

    expect(requests).toHaveLength(1);
    expect(response).toEqual({ status: 200, json: { result: "ok" } });
  });

  it("exchanges the authorization code over the injected transport and stores the tokens", async () => {
    const { base, requests } = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 })
      );
    });
    const plugin = pluginWith({}, base);
    const auth = new AuthManager(plugin, nodeTransport);

    let authUrl = "";
    (globalThis as unknown as { window: { open: (url: string) => void } }).window = {
      open: (url: string) => (authUrl = url),
    };
    auth.startOAuthFlow();
    const state = new URL(authUrl).searchParams.get("state")!;

    await auth.handleCallback("code-1", state);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/oauth_token.do");
    expect(requests[0]!.body).toContain("grant_type=authorization_code");
    expect(requests[0]!.body).toContain("code=code-1");
    expect(plugin.authTokens.accessToken).toBe("new-access");
    expect(plugin.authTokens.refreshToken).toBe("new-refresh");
  });
});
