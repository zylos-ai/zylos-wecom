# CLAUDE.md

Development guidelines for zylos-wecom.

## Project Conventions

- **ESM only** -- Use `import`/`export`, never `require()`. All files use ES Modules (`"type": "module"` in package.json)
- **Node.js 20+** -- Minimum runtime version
- **Conventional commits** -- `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **No `files` in package.json** -- Rely on `.gitignore` to exclude unnecessary files
- **Secrets in `.env` only** -- Never commit secrets. Use `~/zylos/.env` for credentials, `config.json` for non-sensitive runtime config
- **English for code** -- Comments, commit messages, PR descriptions, and documentation in English

## Release Process

When releasing a new version, **all four files** must be updated in the same commit:

1. **`package.json`** — Bump `version` field
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`SKILL.md`** — Update `version` in YAML frontmatter to match package.json
4. **`CHANGELOG.md`** — Add new version entry following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

## Architecture

This is a **communication component** for the Zylos agent ecosystem (WeCom/企业微信).
Uses **WebSocket long connection** mode (智能机器人长连接) — no public IP, SSL, or callback URL needed.

- `src/index.js` -- Main entry point (WebSocket client + internal HTTP API)
- `src/admin.js` -- Admin CLI (config, groups, whitelist management)
- `src/lib/config.js` -- Config loader with hot-reload
- `scripts/send.js` -- C4 outbound message interface (via internal HTTP API)
- `hooks/` -- Lifecycle hooks (post-install, pre-upgrade, post-upgrade)
- `ecosystem.config.cjs` -- PM2 service config (CommonJS required by PM2)

See [DESIGN.md](./DESIGN.md) for full architecture documentation.

## WeCom WebSocket Protocol

- Connection: `wss://openws.work.weixin.qq.com`
- Auth: botId + secret via `aibot_subscribe` frame
- Heartbeat: `ping` every 30 seconds
- Receive: `aibot_msg_callback` / `aibot_event_callback` JSON frames
- Send: `aibot_respond_msg` (reply) / `aibot_send_msg` (proactive) JSON frames
- Only dependency: `ws` (WebSocket client library)
