#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  checkBatchInputShape,
  checkBatchTool,
  checkBatchToolDescription,
  checkDomainInputShape,
  checkDomainTool,
  checkDomainToolDescription,
  checkEmailInputShape,
  checkEmailTool,
  checkEmailToolDescription,
  type ToolDeps,
} from "./tools.js";

// The MCP (Model Context Protocol) stdio transport uses standard output as the
// wire format for protocol messages, so nothing in this process may write to
// stdout. All diagnostics go to standard error instead, both here and in
// client.ts.

function readToolDeps(): ToolDeps {
  return { apiKey: process.env.ISITDISPOSABLE_API_KEY };
}

const server = new McpServer({
  name: "isitdisposable-mcp",
  version: "0.1.0",
});

server.registerTool(
  "check_email",
  {
    title: "Check email for disposable",
    description: checkEmailToolDescription,
    inputSchema: checkEmailInputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async (input) => checkEmailTool(input, readToolDeps()),
);

server.registerTool(
  "check_domain",
  {
    title: "Check domain for disposable",
    description: checkDomainToolDescription,
    inputSchema: checkDomainInputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async (input) => checkDomainTool(input, readToolDeps()),
);

server.registerTool(
  "check_batch",
  {
    title: "Check a batch of emails and domains for disposable",
    description: checkBatchToolDescription,
    inputSchema: checkBatchInputShape,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async (input) => checkBatchTool(input, readToolDeps()),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (!process.env.ISITDISPOSABLE_API_KEY) {
    console.error(
      "[isitdisposable-mcp] warning: ISITDISPOSABLE_API_KEY is not set. The server will start, but every " +
        "tool call will return an error until it is configured. Get a free key at https://isitdisposable.com.",
    );
  }
  console.error("[isitdisposable-mcp] server running on stdio");
}

main().catch((error) => {
  console.error("[isitdisposable-mcp] fatal error:", error);
  process.exit(1);
});
