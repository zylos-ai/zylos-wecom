# Changelog

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
