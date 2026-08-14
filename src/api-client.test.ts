import { describe, it, expect, vi } from "vitest";
import { ApiClient } from "./api-client";
import type { AuthManager } from "./auth-manager";
import type { SNDocument } from "./types";

const PAGE_SIZE = 500;

function doc(n: number): SNDocument {
  return {
    sys_id: `id-${n}`,
    title: `doc ${n}`,
    content: "body",
    category: "session_log",
    project: "p",
    tags: "",
    author: "",
    last_editor: "",
    checked_out_by: "",
    sys_updated_on: "2026-08-11 00:00:00",
    content_hash: "",
  } as SNDocument;
}

/** AuthManager stub whose authenticatedFetch is driven by a queue of responses. */
function clientWith(
  handler: (url: string) => { status: number; json: unknown } | null
): { client: ApiClient; urls: string[] } {
  const urls: string[] = [];
  const authManager = {
    authenticatedFetch: vi.fn(async (url: string) => {
      urls.push(url);
      return handler(url);
    }),
  } as unknown as AuthManager;

  return {
    client: new ApiClient(authManager, "https://x.service-now.com", "/api/etgr/eg_docs", "/metadata"),
    urls,
  };
}

function pageOf(count: number, startAt: number) {
  return {
    status: 200,
    json: { result: Array.from({ length: count }, (_, i) => doc(startAt + i)) },
  };
}

function offsetOf(url: string): number {
  const m = /offset=(\d+)/.exec(url);
  if (!m) throw new Error(`no offset in ${url}`);
  return parseInt(m[1]!, 10);
}

describe("ApiClient.getDocuments pagination", () => {
  it("requests an explicit limit and offset", async () => {
    const { client, urls } = clientWith(() => pageOf(3, 0));

    await client.getDocuments();

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`limit=${PAGE_SIZE}`);
    expect(urls[0]).toContain("offset=0");
  });

  it("pages through until a short page and concatenates every document", async () => {
    // 1200 docs => full, full, then 200.
    const { client, urls } = clientWith((url) => {
      const offset = offsetOf(url);
      const remaining = 1200 - offset;
      return pageOf(Math.min(remaining, PAGE_SIZE), offset);
    });

    const res = await client.getDocuments();

    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(1200);
    expect(res.data![0]!.sys_id).toBe("id-0");
    expect(res.data![1199]!.sys_id).toBe("id-1199");
    expect(urls.map(offsetOf)).toEqual([0, 500, 1000]);
  });

  it("stops after one request when the first page is short", async () => {
    const { client, urls } = clientWith(() => pageOf(10, 0));

    const res = await client.getDocuments();

    expect(res.data).toHaveLength(10);
    expect(urls).toHaveLength(1);
  });

  it("stops when an exactly-full page is followed by an empty one", async () => {
    const { client, urls } = clientWith((url) => {
      const offset = offsetOf(url);
      return offset === 0 ? pageOf(PAGE_SIZE, 0) : pageOf(0, 0);
    });

    const res = await client.getDocuments();

    expect(res.data).toHaveLength(PAGE_SIZE);
    expect(urls).toHaveLength(2);
  });

  it("surfaces a failure on a later page instead of returning partial data", async () => {
    // Truncated results are worse than an error: callers like initialPull and
    // deleteAllAndRepull treat a short list as the complete server state.
    const { client } = clientWith((url) =>
      offsetOf(url) === 0 ? pageOf(PAGE_SIZE, 0) : { status: 500, json: {} }
    );

    const res = await client.getDocuments();

    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.data).toBeNull();
  });

  it("surfaces a failure when the very first page fails", async () => {
    const { client } = clientWith(() => ({ status: 403, json: {} }));

    const res = await client.getDocuments();

    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  it("does not loop forever if the server ignores offset", async () => {
    // An un-upgraded server that ignores `offset` would otherwise hand back the
    // same full page indefinitely.
    const { client, urls } = clientWith(() => pageOf(PAGE_SIZE, 0));

    const res = await client.getDocuments();

    expect(res.ok).toBe(false);
    expect(urls.length).toBeLessThanOrEqual(101);
  });
});
