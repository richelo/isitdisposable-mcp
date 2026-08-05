import { describe, expect, it, vi, type Mock } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  checkBatchInputSchema,
  checkBatchTool,
  checkDomainInputSchema,
  checkDomainTool,
  checkEmailInputSchema,
  checkEmailTool,
  toCheckItems,
  type ToolDeps,
} from "../src/tools.js";
import type { CheckResponse } from "../src/client.js";

function sampleCheckResponse(overrides: Partial<CheckResponse> = {}): CheckResponse {
  return {
    checked: true,
    normalized_email: "person@example.com",
    domain: "example.com",
    disposable: false,
    mx_valid: true,
    role_account: false,
    relay: false,
    public_domain: false,
    spam_risk: null,
    mx_masked: null,
    did_you_mean: null,
    mx_records: ["mail.example.com"],
    action: "allow",
    reason: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function firstText(result: CallToolResult): string {
  const item = result.content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected a text content item.");
  }
  return item.text;
}

type MockFetch = (input: string, init?: RequestInit) => Promise<Response>;

// Note: overrides is a plain object rather than a plain `apiKey` parameter with a default value,
// because an explicit `undefined` argument would otherwise re-trigger the default value.
function depsWith(fetchImpl: Mock<MockFetch>, overrides: Partial<ToolDeps> = {}): ToolDeps {
  return { apiKey: "sk_test_123", fetchImpl: fetchImpl as unknown as typeof fetch, ...overrides };
}

describe("toCheckItems", () => {
  it("sends entries containing an @ sign as email and the rest as domain", () => {
    expect(toCheckItems(["person@example.com", "example.org"])).toEqual([
      { email: "person@example.com" },
      { domain: "example.org" },
    ]);
  });
});

describe("checkEmailTool", () => {
  it("returns the parsed verdict and sends the bearer token to POST /v1/check", async () => {
    const body = sampleCheckResponse({ disposable: true, action: "block", reason: "known_disposable_domain" });
    const fetchImpl = vi.fn<MockFetch>(async () => jsonResponse(body));
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "throwaway@mailinator.com" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.isitdisposable.com/v1/check");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_123");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ email: "throwaway@mailinator.com" });
  });

  it("returns an actionable error, without throwing, when no API key is configured", async () => {
    const fetchImpl = vi.fn<MockFetch>();
    const deps = depsWith(fetchImpl, { apiKey: undefined });

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("isitdisposable.com");
    expect(text).toContain("ISITDISPOSABLE_API_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open with an inconclusive result when every attempt rejects at the network level", async () => {
    const fetchImpl = vi.fn<MockFetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      checked: false,
      disposable: null,
      action: "allow",
      reason: "network_error",
    });
    expect(typeof (result.structuredContent as { note?: unknown }).note).toBe("string");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails open with an inconclusive result after two 500 responses", async () => {
    const fetchImpl = vi.fn<MockFetch>(async () =>
      jsonResponse({ detail: { reason: "server_error", message: "boom" } }, 500),
    );
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      checked: false,
      action: "allow",
      reason: "server_error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails open with an inconclusive result when a 200 body is valid JSON but not an object", async () => {
    // A bare null (or array, or scalar) under an HTTP 200 status is a service
    // malfunction; the agent must see an inconclusive result, never a
    // wrong-shaped success.
    const fetchImpl = vi.fn<MockFetch>(async () => jsonResponse(null, 200));
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      checked: false,
      action: "allow",
      reason: "server_error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails open with an inconclusive result when a batch 200 body is a bare array", async () => {
    const fetchImpl = vi.fn<MockFetch>(async () => jsonResponse([1, 2, 3], 200));
    const deps = depsWith(fetchImpl);

    const result = await checkBatchTool({ items: ["person@example.com"] }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      checked: false,
      action: "allow",
      reason: "server_error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails open with an inconclusive result after two 429 responses and warns on stderr", async () => {
    const fetchImpl = vi.fn<MockFetch>(async () =>
      jsonResponse(
        { detail: { reason: "rate_limited", message: "slow down" } },
        429,
        { "Retry-After": "1" },
      ),
    );
    const deps = depsWith(fetchImpl);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      checked: false,
      action: "allow",
      reason: "rate_limited",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it("returns the real result when the first attempt fails but the retry succeeds", async () => {
    const body = sampleCheckResponse();
    const fetchImpl = vi
      .fn<MockFetch>()
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async () => jsonResponse(body));
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(body);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps a 401 response to an actionable error result without retrying", async () => {
    const fetchImpl = vi.fn<MockFetch>(async () =>
      jsonResponse(
        { detail: { reason: "invalid_api_key", message: "The API key is invalid." } },
        401,
      ),
    );
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("invalid_api_key");
    expect(text).toContain("The API key is invalid.");
    expect(text).toContain("isitdisposable.com");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the generic fallback message, not a crash, when a 403 response returns a non-JSON (HTML) body", async () => {
    const fetchImpl = vi.fn<MockFetch>(async () =>
      new Response("<html><body>Forbidden</body></html>", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("unknown_error");
    expect(text).toContain("Request failed with status 403.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the generic fallback message, not a crash, when a 422 response returns a non-JSON (HTML) body", async () => {
    const fetchImpl = vi.fn<MockFetch>(async () =>
      new Response("<html><body>Unprocessable</body></html>", {
        status: 422,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const deps = depsWith(fetchImpl);

    const result = await checkEmailTool({ email: "person@example.com" }, deps);

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("unknown_error");
    expect(text).toContain("Request failed with status 422.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once and fails open with reason network_error when every attempt times out, leaking no timers", async () => {
    vi.useFakeTimers();
    try {
      // A fetch mock that never resolves on its own, but respects the abort signal
      // fetchWithTimeout attaches, the same way the real platform fetch would when a
      // request is aborted.
      const neverResolvingFetch = vi.fn<MockFetch>((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("The operation was aborted."));
          });
        });
      });
      const deps = depsWith(neverResolvingFetch);

      const resultPromise = checkEmailTool({ email: "person@example.com" }, deps);

      // First attempt: advance past fetchWithTimeout's 10 second per-attempt timeout.
      await vi.advanceTimersByTimeAsync(10_000);
      // The 500ms backoff between the first attempt and the retry.
      await vi.advanceTimersByTimeAsync(500);
      // Retry attempt: advance past its own 10 second per-attempt timeout.
      await vi.advanceTimersByTimeAsync(10_000);

      const result = await resultPromise;

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        checked: false,
        disposable: null,
        action: "allow",
        reason: "network_error",
      });
      expect(neverResolvingFetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("checkDomainTool", () => {
  it("returns the parsed verdict and sends the domain to POST /v1/check", async () => {
    const body = sampleCheckResponse({ normalized_email: null, domain: "mailinator.com", disposable: true });
    const fetchImpl = vi.fn<MockFetch>(async () => jsonResponse(body));
    const deps = depsWith(fetchImpl);

    const result = await checkDomainTool({ domain: "mailinator.com" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(body);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.isitdisposable.com/v1/check");
    expect(JSON.parse(init.body as string)).toEqual({ domain: "mailinator.com" });
  });
});

describe("checkBatchTool", () => {
  it("maps mixed emails and domains to the right request items and calls POST /v1/check/batch", async () => {
    const body = {
      results: [sampleCheckResponse(), sampleCheckResponse({ domain: "example.org", disposable: false })],
      summary: { count: 2 },
    };
    const fetchImpl = vi.fn<MockFetch>(async () => jsonResponse(body));
    const deps = depsWith(fetchImpl);

    const result = await checkBatchTool({ items: ["person@example.com", "example.org"] }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(body);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.isitdisposable.com/v1/check/batch");
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ email: "person@example.com" }, { domain: "example.org" }],
    });
  });
});

describe("checkEmailInputSchema", () => {
  it("rejects an empty string", () => {
    const parsed = checkEmailInputSchema.safeParse({ email: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a wrong type", () => {
    const parsed = checkEmailInputSchema.safeParse({ email: 12345 });
    expect(parsed.success).toBe(false);
  });

  it("accepts a normal value", () => {
    const parsed = checkEmailInputSchema.safeParse({ email: "person@example.com" });
    expect(parsed.success).toBe(true);
  });
});

describe("checkDomainInputSchema", () => {
  it("rejects an empty string", () => {
    const parsed = checkDomainInputSchema.safeParse({ domain: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a wrong type", () => {
    const parsed = checkDomainInputSchema.safeParse({ domain: 12345 });
    expect(parsed.success).toBe(false);
  });

  it("accepts a normal value", () => {
    const parsed = checkDomainInputSchema.safeParse({ domain: "example.com" });
    expect(parsed.success).toBe(true);
  });
});

describe("checkBatchInputSchema", () => {
  it("rejects an empty items array", () => {
    const parsed = checkBatchInputSchema.safeParse({ items: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a 101 item array", () => {
    const items = Array.from({ length: 101 }, (_, index) => `user${index}@example.com`);
    const parsed = checkBatchInputSchema.safeParse({ items });
    expect(parsed.success).toBe(false);
  });

  it("accepts a 100 item array", () => {
    const items = Array.from({ length: 100 }, (_, index) => `user${index}@example.com`);
    const parsed = checkBatchInputSchema.safeParse({ items });
    expect(parsed.success).toBe(true);
  });
});
