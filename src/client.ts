/**
 * A small, self-contained client for the isitdisposable.com REST (Representational
 * State Transfer) API. It deliberately depends on nothing but the platform fetch
 * function so it never depends on an unpublished or unstable package.
 */

export const DEFAULT_BASE_URL = "https://api.isitdisposable.com";

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 500;

/** One item sent to POST /v1/check or as an entry inside POST /v1/check/batch. */
export interface CheckItem {
  email?: string;
  domain?: string;
}

/** The shape returned by the API for a single checked email or domain. */
export interface CheckResponse {
  checked: boolean;
  normalized_email: string | null;
  domain: string | null;
  disposable: boolean | null;
  mx_valid: boolean | null;
  role_account: boolean | null;
  relay: boolean | null;
  public_domain: boolean | null;
  spam_risk: boolean | null;
  mx_masked: boolean | null;
  did_you_mean: string | null;
  mx_records: string[] | null;
  action: "allow" | "warn" | "block";
  reason: string | null;
  /** Present only on the inconclusive, fail open result this client synthesizes locally. */
  note?: string;
}

export interface BatchCheckResponse {
  results: CheckResponse[];
  summary: {
    count: number;
  };
}

/** The body isitdisposable.com returns for 400, 401, 403, and 429 responses. */
export interface ApiErrorBody {
  detail: {
    reason: string;
    message: string;
  };
}

/** Raised when the API responds with a client error that the caller must fix (400, 401, 403, 422). */
export class ApiClientError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.reason = reason;
  }
}

/** The three fail open outcomes this client synthesizes instead of throwing. */
export type FailOpenReason = "network_error" | "rate_limited" | "server_error";

/** Raised internally to signal a fail open condition (network trouble, 429, or 5xx after retry). */
export class FailOpenError extends Error {
  readonly reason: FailOpenReason;

  constructor(reason: FailOpenReason, message: string) {
    super(message);
    this.name = "FailOpenError";
    this.reason = reason;
  }
}

export interface ApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function buildInconclusiveResult(reason: FailOpenReason, note: string): CheckResponse {
  return {
    checked: false,
    normalized_email: null,
    domain: null,
    disposable: null,
    mx_valid: null,
    role_account: null,
    relay: null,
    public_domain: null,
    spam_risk: null,
    mx_masked: null,
    did_you_mean: null,
    mx_records: null,
    action: "allow",
    reason,
    note,
  };
}

/** The inconclusive, fail open result returned for network trouble, timeouts, 429, and 5xx. */
export function inconclusiveResult(reason: FailOpenReason): CheckResponse {
  const note =
    "The disposable email check could not be completed. This result is inconclusive, not a safe verdict.";
  return buildInconclusiveResult(reason, note);
}

async function parseErrorBody(response: Response): Promise<{ reason: string; message: string }> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body && body.detail && typeof body.detail === "object") {
      return {
        reason: body.detail.reason ?? "unknown_error",
        message: body.detail.message ?? `Request failed with status ${response.status}.`,
      };
    }
  } catch {
    // Fall through to the generic message below.
  }
  return {
    reason: "unknown_error",
    message: `Request failed with status ${response.status}.`,
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * isitdisposable.com REST API client. Every method is fail open: on network
 * trouble, a timeout, HTTP 429, or a 5xx response, it retries once after a short
 * backoff and then throws a FailOpenError instead of a hard error, so the caller
 * can hand the agent an inconclusive result rather than a crash.
 */
export class IsItDisposableClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkOne(item: CheckItem): Promise<CheckResponse> {
    return this.postWithRetry<CheckResponse>("/v1/check", item);
  }

  async checkBatch(items: CheckItem[]): Promise<BatchCheckResponse> {
    return this.postWithRetry<BatchCheckResponse>("/v1/check/batch", { items });
  }

  private async postWithRetry<T>(path: string, body: unknown): Promise<T> {
    try {
      return await this.postOnce<T>(path, body);
    } catch (error) {
      if (error instanceof ApiClientError) {
        // 400/401/403/422 are caller errors, not fail open conditions. Do not retry.
        throw error;
      }
      const reason = this.classifyFailOpenReason(error);
      process.stderr.write(
        `[isitdisposable-mcp] warning: request to ${path} failed (${reason}), retrying once...\n`,
      );
      await sleep(RETRY_BACKOFF_MS);
      try {
        return await this.postOnce<T>(path, body);
      } catch (retryError) {
        if (retryError instanceof ApiClientError) {
          throw retryError;
        }
        const retryReason = this.classifyFailOpenReason(retryError);
        process.stderr.write(
          `[isitdisposable-mcp] warning: retry to ${path} also failed (${retryReason}), returning an inconclusive result.\n`,
        );
        throw new FailOpenError(retryReason, `Request to ${path} failed after one retry.`);
      }
    }
  }

  private classifyFailOpenReason(error: unknown): FailOpenReason {
    if (error instanceof RateLimitedError) {
      return "rate_limited";
    }
    if (error instanceof ServerError) {
      return "server_error";
    }
    return "network_error";
  }

  private async postOnce<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new NetworkError(error instanceof Error ? error.message : String(error));
    }

    if (response.status === 429) {
      throw new RateLimitedError("The API responded with 429 (rate limited).");
    }
    if (response.status >= 500) {
      throw new ServerError(`The API responded with status ${response.status}.`);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) {
      const { reason, message } = await parseErrorBody(response);
      throw new ApiClientError(response.status, reason, message);
    }
    if (!response.ok) {
      // Any other unexpected non-success status is treated as a fail open server error.
      throw new ServerError(`The API responded with an unexpected status ${response.status}.`);
    }

    const parsed: unknown = await response.json().catch(() => {
      throw new ServerError("The API responded with a 200 body that was not valid JSON.");
    });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Valid JSON that is not an object (a bare null, array, or scalar) is a
      // service malfunction. Throwing ServerError routes it through the same
      // retry and fail open path as a 5xx, so the agent sees an inconclusive
      // result instead of a wrong-shaped success.
      throw new ServerError("The API responded with a 200 body that was not a response object.");
    }
    return parsed as T;
  }
}

class NetworkError extends Error {}
class RateLimitedError extends Error {}
class ServerError extends Error {}
