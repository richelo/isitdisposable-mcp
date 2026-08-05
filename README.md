# isitdisposable-mcp

A Model Context Protocol (MCP) server that lets an AI agent check whether an email address or domain is disposable, using the isitdisposable.com application programming interface (API).

## Installation

The server is published to the npm registry and is normally run with `npx`, so there is nothing to install by hand; the examples below show how to wire it into a Model Context Protocol (MCP) host.

### Claude Desktop

Add this to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "isitdisposable": {
      "command": "npx",
      "args": ["-y", "isitdisposable-mcp"],
      "env": { "ISITDISPOSABLE_API_KEY": "your_secret_key" }
    }
  }
}
```

### Claude Code

```
claude mcp add isitdisposable --env ISITDISPOSABLE_API_KEY=your_secret_key -- npx -y isitdisposable-mcp
```

## Getting an API key

An isitdisposable.com key is required. Get a free key at https://isitdisposable.com (a free tier is available), then set it as `ISITDISPOSABLE_API_KEY` in the configuration above.

## Tools

| Tool | What it does |
| --- | --- |
| `check_email` | Checks a single email address to see whether it is disposable. |
| `check_domain` | Checks a single bare domain (no local part) to see whether it is disposable. |
| `check_batch` | Checks up to 100 email addresses or bare domains at once in a single call. Mix full addresses and bare domains freely in the `items` list; entries containing an `@` sign are sent as email addresses, everything else as a domain. |

Every tool returns the same verdict shape. `disposable` is the core true or false verdict: a disposable address is a throwaway or temporary inbox used to receive a single signup message and evade normal registration requirements, rather than a real, ongoing mailbox. `action` is the recommended handling of `allow`, `warn`, or `block`. A handful of opt in signals may also be present, including `mx_valid` (whether the domain's mail servers accept mail), `relay` (a forwarding or catch all style address), `public_domain` (a well known free provider such as Gmail), and `did_you_mean` (a likely intended domain when the one given looks like a typo).

## Fail open behavior

This server always fails open. If a network problem, a timeout, a rate limit, or a server error prevents a real check from completing, the tool call still succeeds (it never throws or crashes the connection). It retries once after a short delay, and if that also fails, it returns a result with `checked: false`, `disposable: null`, and `action: "allow"`, along with a `note` explaining that the check could not be completed. An agent using this tool should treat that outcome as inconclusive, not as a signal that the address is safe.

If no API key is configured, the server still starts normally and responds to the Model Context Protocol (MCP) handshake; each tool call then returns an error result pointing to https://isitdisposable.com to get a free key.

## Publishing (manual)

```
cd ~/Code/active/isid-mcp
npm install
npm run build
npm test
npm login
npm publish
```

`server.json` is currently written against the 2025-12-11 registry schema. The registry schema can drift again, so before a future registry submission, validate `server.json` against the exact schema URL named in its own `$schema` field, or upgrade `mcp-publisher` to the latest release and run its `validate` command (older releases, including the one this file was first written with, lack that command and generate an outdated template).
