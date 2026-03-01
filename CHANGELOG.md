# Changelog

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
