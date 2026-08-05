# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-05

### Changed

- The README no longer includes the maintainer publishing section.

## [0.1.0] - 2026-08-05

### Added

- Initial release of the isitdisposable.com Model Context Protocol (MCP) server.
- Three tools: `check_email` (checks a single email address), `check_domain`
  (checks a single bare domain), and `check_batch` (checks up to 100 email
  addresses or domains at once).
- A stdio transport server, suitable for local, process spawned Model Context
  Protocol hosts such as Claude Desktop and Claude Code.
- A fail open posture on network trouble, timeouts, rate limiting, and server
  errors: after one retry, a tool call returns an inconclusive result rather
  than an error, so a temporary outage never looks like a false negative.
- A clear, actionable error when no application programming interface (API)
  key is configured, pointing to https://isitdisposable.com for a free key.
