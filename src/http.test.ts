import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { httpRequest } from "./http";

let server: http.Server | null = null;

/** Starts a real loopback server and returns its base URL. */
async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = null;
});

describe("httpRequest", () => {
  it("resolves the status and parsed json for a 2xx response", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "abc", expires_in: 1800 }));
    });

    const response = await httpRequest({ url: `${base}/oauth_token.do`, method: "POST" }, http.request);

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ access_token: "abc", expires_in: 1800 });
  });

  it("throws an error carrying status and json for a non-2xx response", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server_error", error_description: "access_denied" }));
    });

    const call = httpRequest({ url: `${base}/oauth_token.do`, method: "POST" }, http.request);

    await expect(call).rejects.toMatchObject({
      status: 401,
      json: { error: "server_error", error_description: "access_denied" },
    });
  });

  it("sends the method, headers and body to the server", async () => {
    const base = await serve((req, res) => {
      let received = "";
      req.on("data", (chunk) => (received += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            contentType: req.headers["content-type"],
            authorization: req.headers["authorization"],
            body: received,
          })
        );
      });
    });

    const response = await httpRequest(
      {
        url: `${base}/oauth_token.do`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer tok" },
        body: "grant_type=refresh_token&refresh_token=r1",
      },
      http.request
    );

    expect(response.json).toEqual({
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      authorization: "Bearer tok",
      body: "grant_type=refresh_token&refresh_token=r1",
    });
  });

  it("rejects when the connection itself fails", async () => {
    const base = await serve(() => {});
    const port = Number(base.split(":")[2]);
    await new Promise((resolve) => server!.close(resolve));
    server = null;

    const call = httpRequest({ url: `http://127.0.0.1:${port}/oauth_token.do` }, http.request);

    await expect(call).rejects.toThrow(/ECONNREFUSED/);
  }, 10000);
});
