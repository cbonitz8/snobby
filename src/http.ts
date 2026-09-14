// Obsidian 1.13.x's Electron requestUrl fails the TLS handshake with
// ERR_SSL_CLIENT_AUTH_CERT_NEEDED against hosts that request a client certificate,
// which ServiceNow instances do. Node's TLS stack completes the same handshake.
import https from "https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "http";

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

/** Mirrors requestUrl's contract: a non-2xx response throws, carrying status and body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly json: unknown
  ) {
    super(`Request failed, status ${status}`);
    this.name = "HttpError";
  }
}

export type RequestFn = (
  url: string,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
) => ClientRequest;

export function httpRequest(
  options: HttpRequestOptions,
  requestFn: RequestFn = https.request as RequestFn
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = requestFn(
      options.url,
      { method: options.method ?? "GET", headers: options.headers ?? {} },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const json = raw ? JSON.parse(raw) : null;
          if (status >= 200 && status < 300) {
            resolve({ status, json });
            return;
          }
          reject(new HttpError(status, json));
        });
      }
    );

    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
