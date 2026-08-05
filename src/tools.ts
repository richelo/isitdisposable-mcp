import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ApiClientError,
  FailOpenError,
  IsItDisposableClient,
  inconclusiveResult,
  type CheckItem,
} from "./client.js";

const GET_A_KEY_MESSAGE =
  "Get a free API key at https://isitdisposable.com and set it as the ISITDISPOSABLE_API_KEY environment variable in the MCP server configuration.";

/**
 * Shared explanation, reused across all three tool descriptions, of what a
 * disposable address is and how to read the response fields. Keeping this in
 * one place keeps the three tools consistent for the calling agent.
 */
const VERDICT_EXPLANATION =
  "A disposable address is a throwaway or temporary inbox (for example from a burner mail service) " +
  "that someone uses to receive a single signup message and evade normal registration requirements, " +
  "rather than a real, ongoing mailbox. In the response, `disposable` is the core true or false verdict. " +
  "`action` is the recommended handling: `allow`, `warn`, or `block`, based on the caller's own account " +
  "policy. Extra opt in signals may also be present: `mx_valid` (whether the domain's mail servers accept " +
  "mail at all), `relay` (a forwarding or catch all style address rather than a dedicated inbox), " +
  "`public_domain` (a well known free provider such as Gmail or Outlook), and `did_you_mean` (a likely " +
  "intended domain when the one given looks like a typo). " +
  "This tool always fails open: if a network problem, timeout, rate limit, or server error prevents a real " +
  "check, the call still succeeds and returns `checked` false with `action` allow, plus a `note` explaining " +
  "the check could not be completed. Treat that outcome as inconclusive, never as evidence the address is safe.";

export const checkEmailInputShape = {
  email: z.string().min(1, "email is required").describe("The full email address to check, for example someone@example.com."),
};
export const checkEmailInputSchema = z.object(checkEmailInputShape);
export type CheckEmailInput = z.infer<typeof checkEmailInputSchema>;

export const checkDomainInputShape = {
  domain: z
    .string()
    .min(1, "domain is required")
    .describe("A bare domain with no local part and no @ sign, for example example.com."),
};
export const checkDomainInputSchema = z.object(checkDomainInputShape);
export type CheckDomainInput = z.infer<typeof checkDomainInputSchema>;

export const checkBatchInputShape = {
  items: z
    .array(z.string().min(1, "each item must be a non-empty string"))
    .min(1, "items must contain at least one entry")
    .max(100, "items cannot contain more than 100 entries")
    .describe(
      "1 to 100 entries, each either a full email address or a bare domain. Entries containing an @ " +
        "sign are checked as email addresses; all other entries are checked as bare domains.",
    ),
};
export const checkBatchInputSchema = z.object(checkBatchInputShape);
export type CheckBatchInput = z.infer<typeof checkBatchInputSchema>;

export const checkEmailToolDescription =
  "Checks a single email address to see whether it is disposable. " + VERDICT_EXPLANATION;

export const checkDomainToolDescription =
  "Checks a single bare domain (no local part, for example when only a company's domain is known and not " +
  "a specific address) to see whether it is disposable. " +
  VERDICT_EXPLANATION;

export const checkBatchToolDescription =
  "Checks up to 100 email addresses or domains at once in a single call, which is far more efficient than " +
  "calling the single-item tools in a loop. Provide a mixed list in `items`: entries containing an @ sign " +
  "are sent as email addresses, and all other entries are sent as bare domains. " +
  VERDICT_EXPLANATION;

/** Everything a tool handler needs to reach the isitdisposable.com API, injected for testability. */
export interface ToolDeps {
  /** Read from the ISITDISPOSABLE_API_KEY environment variable by the caller; undefined when unset. */
  apiKey: string | undefined;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch when omitted. */
  fetchImpl?: typeof fetch;
}

function textResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(reason: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${reason}: ${message}` }],
  };
}

function missingApiKeyResult(): CallToolResult {
  return errorResult("missing_api_key", `No isitdisposable.com API key is configured. ${GET_A_KEY_MESSAGE}`);
}

function clientErrorResult(error: ApiClientError): CallToolResult {
  const suffix = error.status === 401 ? ` ${GET_A_KEY_MESSAGE}` : "";
  return errorResult(error.reason, `${error.message}${suffix}`);
}

async function runCheck(
  deps: ToolDeps,
  call: (client: IsItDisposableClient) => Promise<unknown>,
): Promise<CallToolResult> {
  if (!deps.apiKey) {
    return missingApiKeyResult();
  }

  const client = new IsItDisposableClient({
    apiKey: deps.apiKey,
    baseUrl: deps.baseUrl,
    fetchImpl: deps.fetchImpl,
  });

  try {
    const data = await call(client);
    return textResult(data);
  } catch (error) {
    if (error instanceof FailOpenError) {
      return textResult(inconclusiveResult(error.reason));
    }
    if (error instanceof ApiClientError) {
      return clientErrorResult(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult("unexpected_error", message);
  }
}

/** Handler for the check_email tool. Exported directly so it can be unit tested without a live server. */
export async function checkEmailTool(input: CheckEmailInput, deps: ToolDeps): Promise<CallToolResult> {
  return runCheck(deps, (client) => client.checkOne({ email: input.email }));
}

/** Handler for the check_domain tool. Exported directly so it can be unit tested without a live server. */
export async function checkDomainTool(input: CheckDomainInput, deps: ToolDeps): Promise<CallToolResult> {
  return runCheck(deps, (client) => client.checkOne({ domain: input.domain }));
}

/** Maps a mixed list of emails and bare domains to the request items the API expects. */
export function toCheckItems(entries: string[]): CheckItem[] {
  return entries.map((entry) => (entry.includes("@") ? { email: entry } : { domain: entry }));
}

/** Handler for the check_batch tool. Exported directly so it can be unit tested without a live server. */
export async function checkBatchTool(input: CheckBatchInput, deps: ToolDeps): Promise<CallToolResult> {
  return runCheck(deps, (client) => client.checkBatch(toCheckItems(input.items)));
}
