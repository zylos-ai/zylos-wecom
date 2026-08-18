# Changelog

## [Unreleased]

### Added
- Pinned official `wecom-cli` install/upgrade integration with version checks
- Fourteen modular official CLI skills and the WeCom Unified aggregate router
- Shell-free CLI bridge with typed authorization errors and focused tests

### Changed
- Official CLI capabilities now take precedence over the legacy document MCP
  compatibility path when both can serve the same operation

## [0.1.5] - 2026-07-19

### Added
- Outbound image/file sending via chunked media upload over the long
  connection (`aibot_upload_media_init/chunk/finish`), with the
  `[MEDIA:image]` / `[MEDIA:file]` send convention in `scripts/send.js`;
  reply path preferred, proactive path as fallback, loud failure with no
  silent text downgrade (#14)
- Per-chat JSONL history persistence with tail replay on restart, so group
  context, idle gating, and learned bot names survive service restarts (#16)
- Idle-gated group-context delivery, continuous bot display-name learning,
  and restructured message envelope (#13)
- `references/platform-limitations.md`: on-demand FAQ covering visibility
  scope, group message-type limits, quoted-media behavior, DM vs group
  differences, external groups, and media size/rate limits

### Fixed
- Mixed-message field name and quote parsing; group-chat documentation (#13)
- mcp-config tests no longer write into the real component data dir: the
  doc MCP config path resolves via `os.homedir()` at call time instead of
  import time (#15)

### Removed
- Smart mode (#13)

## [0.1.4] - 2026-05-18

### Fixed
- Post-upgrade hook now backs up `config.json` to
  `config.json.backup.<ISO-timestamp>` before mutation and uses atomic
  write (temp + rename) for the new config (#7)

### Removed
- Reverted in-config `_legacy_*` field injection
  (`_legacy_webhook_port`, `_legacy_bot`, `_legacy_proxy`,
  `_legacy_message_useMarkdownCard`, `_legacy_message_useMarkdown`) in
  favor of whole-file backups; the original config schema is preserved (#7)

## [0.1.3] - 2026-04-04

### Added
- Dashboard-driven WeCom scan onboarding flow with reusable QR session polling

### Changed
- Return `botSecret` alongside `botId` after WeCom scan onboarding succeeds so dashboard reconciliation can persist refreshed credentials
- Restart the `zylos-wecom` PM2 service after scan onboarding succeeds, with ecosystem fallback when the process was deleted

## [0.1.2] - 2026-03-30

### Added
- WeCom doc MCP bootstrap flow and auth guidance updates
- Locale-aware runtime / CLI / welcome / doc-auth messaging
- OpenClaw-style thinking placeholder and stream reply alignment

### Changed
- Refresh WeCom doc MCP config on demand
- Normalize WeCom C4 message wrapper to structured `group-context` / `current-message` format with XML escaping

## [0.1.1] - 2026-03-21

### Changed
- **Breaking**: Switched from HTTP webhook callback to WebSocket long connection mode (智能机器人长连接)
- Only 2 credentials needed: `WECOM_BOT_ID` + `WECOM_BOT_SECRET` (previously 5)
- No public IP, SSL, or callback URL required
- Replaced Express webhook server with WebSocket client (`ws` library)
- Messages sent via WebSocket frames instead of REST API
- send.js now communicates with main process via internal HTTP API

### Removed
- Express HTTP webhook server
- AES-256-CBC encryption/decryption (not needed for WebSocket mode)
- Access token management (bot mode doesn't use corp API)
- User info lookup via corp API (names now from message callbacks)
- Media upload/download via REST API
- Dependencies: `express`, `axios`, `form-data`

### Added
- WebSocket connection with automatic reconnection (exponential backoff + jitter)
- Heartbeat (30-second ping interval)
- Reply mode: uses original request ID for responses within 5-minute window
- Proactive send fallback when reply window expires
- `ws` dependency for WebSocket client

## [0.1.0] - 2026-02-28

### Added
- Initial release
- WeCom webhook server (Express) with encrypted message handling
- AES-256-CBC message encryption/decryption per WeCom spec
- SHA1 signature verification for webhook callbacks
- Access token management with automatic caching and refresh
- Text, markdown, image, and file message sending
- Media upload and download via WeCom temporary media API
- C4 Communication Bridge integration (send.js / c4-receive.js)
- Owner auto-binding on first private message
- DM access control (open / allowlist / owner policies)
- Group access control (open / allowlist / disabled policies)
- Per-group allowFrom sender restrictions
- User name resolution with in-memory cache and file persistence
- In-memory chat history for context messages
- Admin CLI for configuration management
- Config hot-reload via file watcher
- Atomic config writes (tmp + rename)
- PM2 service configuration
- Lifecycle hooks (post-install, pre-upgrade, post-upgrade)
- Graceful shutdown handling
- Message deduplication
- Long message splitting with markdown-aware chunking
